import { createRequire } from 'node:module'
import { command, config, formatDuration, jid, on, type Message } from '../core/index.js'

// ---------- dictionary (loaded on first use, ~275k words) ----------

let dictionary: Set<string> | undefined
let wordList: string[] | undefined

function loadWords(): string[] {
  if (!wordList) {
    wordList = createRequire(import.meta.url)('an-array-of-english-words') as string[]
    dictionary = new Set(wordList)
  }
  return wordList
}
const isWord = (w: string) => {
  loadWords()
  return dictionary!.has(w)
}
const pick = <T>(list: T[]): T => list[Math.floor(Math.random() * list.length)]

// ---------- shared ----------

interface WcgGame {
  kind: 'wcg'
  phase: 'lobby' | 'playing'
  host: string
  /** Everyone who joined, in join order (phone-number jids). */
  players: string[]
  /** Players still in the game. */
  alive: string[]
  turn: number
  letter: string
  minLen: number
  /** How many turns were taken this round; a round ends when every alive player has played. */
  turnsThisRound: number
  used: Set<string>
  wordCount: number
  longest: { word: string; by: string }
  startedAt: number
  last: Message
  timers: NodeJS.Timeout[]
}

interface WrgGame {
  kind: 'wrg'
  rounds: number
  round: number
  fragment: string
  /** A word that proves the fragment is solvable; shown when nobody answers. */
  example: string
  scores: Map<string, number>
  last: Message
  timers: NodeJS.Timeout[]
}

type Game = WcgGame | WrgGame
const games = new Map<string, Game>()

const JOIN_WINDOW_S = 60
const WCG_TURN_S = 30
const WRG_ROUND_S = 20
const WRG_DEFAULT_ROUNDS = 5
const MAX_MIN_LEN = 9

const tag = (user: string) => `@${jid.toNumber(user)}`
const isCommandText = (text: string) => {
  const first = text.trim()[0]
  return !!first && config.prefix.includes(first)
}

function clearGame(chat: string, game: Game | undefined = games.get(chat)) {
  if (!game) return
  for (const t of game.timers) clearTimeout(t)
  game.timers = []
  if (games.get(chat) === game) games.delete(chat)
}

/** setTimeout that is tracked on the game and skipped if the game was replaced in the meantime. */
function later(chat: string, game: Game, ms: number, fn: () => unknown) {
  const t = setTimeout(() => {
    game.timers = game.timers.filter((x) => x !== t)
    if (games.get(chat) !== game) return
    Promise.resolve(fn()).catch(() => {})
  }, ms)
  game.timers.push(t)
}

const sameAny = async (msg: Message, users: string[]) => {
  for (const u of users) if (await msg.jids.same(msg.sender, u)) return u
  return undefined
}

/** `wcg end` / `wrg end`: players (or sudo) may stop whichever game is running here. */
async function endAny(msg: Message, game: Game) {
  if (game.kind === 'wcg' && !msg.isSudo && !(await sameAny(msg, game.players))) return msg.reply('_Only players can end this game._')
  game.last = msg
  if (game.kind === 'wrg' && game.scores.size) return wrgFinish(msg.chat, game)
  clearGame(msg.chat, game)
  return msg.reply('🏁 Game ended.')
}

// ---------- word chain game ----------

function wcgTurnText(game: WcgGame): string {
  const current = game.alive[game.turn]
  const next = game.alive[(game.turn + 1) % game.alive.length]
  return [
    `🎲 Turn: ${tag(current)}`,
    `🙌 Next: ${tag(next)}`,
    `🆎 Starts with *${game.letter.toUpperCase()}* (at least ${game.minLen} letters)`,
    `🏆 Players left: ${game.alive.length}/${game.players.length}`,
    `⏳ You have *${WCG_TURN_S}* seconds to reply`,
    `📝 Total words: ${game.wordCount}`,
  ].join('\n')
}

async function wcgAnnounceTurn(chat: string, game: WcgGame) {
  const current = game.alive[game.turn]
  const next = game.alive[(game.turn + 1) % game.alive.length]
  await game.last.send(wcgTurnText(game), { mentions: [current, next] })
  later(chat, game, WCG_TURN_S * 1000, () => wcgEliminate(chat, game, current, `⏰ Time out ${tag(current)}! You are out! 🚫`))
}

async function wcgEliminate(chat: string, game: WcgGame, user: string, reason: string) {
  const idx = game.alive.indexOf(user)
  if (idx === -1) return
  game.alive.splice(idx, 1)
  await game.last.send(reason, { mentions: [user] })
  if (game.alive.length <= 1) return wcgFinish(chat, game)
  // the removed player's slot now points at the next player
  game.turn = idx % game.alive.length
  await wcgAdvanceRound(game)
  await wcgAnnounceTurn(chat, game)
}

/** Bump the minimum length once every alive player has had a turn. */
async function wcgAdvanceRound(game: WcgGame) {
  game.turnsThisRound++
  if (game.turnsThisRound >= game.alive.length) {
    game.turnsThisRound = 0
    game.minLen = Math.min(MAX_MIN_LEN, game.minLen + 1)
  }
}

async function wcgFinish(chat: string, game: WcgGame) {
  clearGame(chat, game)
  const winner = game.alive[0]
  if (!winner) return game.last.send('🏁 Game ends. Nobody survived!')
  const mentions = [winner, game.longest.by].filter(Boolean)
  const longest = game.longest.word ? `\nLongest word: *${game.longest.word} (${game.longest.word.length})* by ${tag(game.longest.by)} 📚` : ''
  await game.last.send(
    `🏁 Game ends!\n${tag(winner)} won the game 🏆\nWords: *${game.wordCount}*${longest}\nTime: *${formatDuration((Date.now() - game.startedAt) / 1000)}* ⏱️`,
    { mentions },
  )
}

async function wcgStart(chat: string, game: WcgGame) {
  for (const t of game.timers) clearTimeout(t)
  game.timers = []
  if (game.players.length < 2) {
    clearGame(chat, game)
    return game.last.send('_Not enough players to start. Game terminated._')
  }
  game.phase = 'playing'
  game.alive = [...game.players].sort(() => Math.random() - 0.5)
  game.turn = 0
  game.letter = pick([...'abcdefghilmnoprstw'])
  game.minLen = 3
  game.startedAt = Date.now()
  await game.last.send(`🎮 Game started with ${game.alive.length} players!\n${game.alive.map(tag).join(', ')}`, { mentions: game.alive })
  await wcgAnnounceTurn(chat, game)
}

command(
  {
    name: 'wcg',
    desc: 'Word chain game: each word must start with the last letter of the previous one',
    usage: '| start | end',
    category: 'game',
    groupOnly: true,
    public: true,
  },
  async (msg, args) => {
    const sub = args.trim().toLowerCase()
    const game = games.get(msg.chat)

    if (sub === 'end') {
      if (!game) return msg.reply('_No word game is running here._')
      return endAny(msg, game)
    }

    if (sub === 'start') {
      if (!game || game.kind !== 'wcg') return msg.reply('_No word chain lobby here. Send *wcg* to create one._')
      if (game.phase === 'playing') return msg.reply('_The game is already running._')
      game.last = msg
      return wcgStart(msg.chat, game)
    }

    if (sub) return msg.reply('_Usage: wcg · wcg start · wcg end_')

    if (game) return msg.reply(game.kind === 'wrg' ? '_A random word game is running here. End it first._' : '_A word chain game is already running here. Use *wcg end* to stop it._')

    const fresh: WcgGame = {
      kind: 'wcg',
      phase: 'lobby',
      host: msg.sender,
      players: [msg.sender],
      alive: [],
      turn: 0,
      letter: 'a',
      minLen: 3,
      turnsThisRound: 0,
      used: new Set(),
      wordCount: 0,
      longest: { word: '', by: '' },
      startedAt: Date.now(),
      last: msg,
      timers: [],
    }
    games.set(msg.chat, fresh)
    loadWords() // warm the dictionary while people join
    await msg.reply(
      `🎮 Word Chain Game starting...\n👥 Need 2 or more players\n⏳ You have ${JOIN_WINDOW_S} seconds to join\nType *join* to play 🙋‍♂️🙋‍♀️\n\n${tag(msg.sender)} joined 👏`,
      { mentions: [msg.sender] },
    )
    later(msg.chat, fresh, (JOIN_WINDOW_S - 30) * 1000, () =>
      fresh.last.send(`🎮 Game starts in 30 seconds ⏳\nType *join* to play 🙋‍♂️🙋‍♀️\n\n👥 ${fresh.players.length} players joined.`),
    )
    later(msg.chat, fresh, JOIN_WINDOW_S * 1000, () => wcgStart(msg.chat, fresh))
  },
)

async function wcgOnText(chat: string, game: WcgGame, msg: Message) {
  const text = msg.text.trim().toLowerCase()

  if (game.phase === 'lobby') {
    if (text !== 'join') return
    if (await sameAny(msg, game.players)) return msg.reply('_You already joined._')
    game.players.push(msg.sender)
    game.last = msg
    return msg.reply(`${tag(msg.sender)} joined 👏\n\n👥 ${game.players.length} players joined.`, { mentions: [msg.sender] })
  }

  // playing: only a bare single word from the current player counts
  if (!/^[a-z]+$/.test(text)) return
  const current = game.alive[game.turn]
  if (!(await msg.jids.same(msg.sender, current))) return

  game.last = msg
  for (const t of game.timers) clearTimeout(t)
  game.timers = []

  const fail = (reason: string) => wcgEliminate(chat, game, current, `${reason}\n${tag(current)}, you are out! 🚫`)
  if (!text.startsWith(game.letter)) return fail(`_${text} is not starting with_ *${game.letter.toUpperCase()}*`)
  if (text.length < game.minLen) return fail(`_This word is below ${game.minLen} letters_`)
  if (game.used.has(text)) return fail('_This word is already used!_')
  if (!isWord(text)) return fail('_This word is not in my list_')

  game.used.add(text)
  game.wordCount++
  if (text.length > game.longest.word.length) game.longest = { word: text, by: current }
  game.letter = text[text.length - 1]
  game.turn = (game.turn + 1) % game.alive.length
  await msg.react('✅').catch(() => {})
  await wcgAdvanceRound(game)
  await wcgAnnounceTurn(chat, game)
}

// ---------- random word game ----------

/** A 3-letter fragment taken from a real word, so there is always at least one answer. */
function randomFragment(): { fragment: string; example: string } {
  const list = loadWords()
  for (;;) {
    const word = pick(list)
    if (word.length < 5 || !/^[a-z]+$/.test(word)) continue
    const start = Math.floor(Math.random() * (word.length - 2))
    return { fragment: word.slice(start, start + 3), example: word }
  }
}

async function wrgNextRound(chat: string, game: WrgGame) {
  game.round++
  if (game.round > game.rounds) return wrgFinish(chat, game)
  const { fragment, example } = randomFragment()
  game.fragment = fragment
  game.example = example
  await game.last.send(`🎲 Round ${game.round}/${game.rounds}\n🔤 Send a word containing *${fragment.toUpperCase()}*\n⏳ You have *${WRG_ROUND_S}* seconds`)
  later(chat, game, WRG_ROUND_S * 1000, async () => {
    await game.last.send(`⏰ Time's up! Nobody got it.\n💡 Example: *${game.example}*`)
    later(chat, game, 2000, () => wrgNextRound(chat, game))
  })
}

function wrgScoreboard(game: WrgGame): { text: string; mentions: string[] } {
  const sorted = [...game.scores.entries()].sort((a, b) => b[1] - a[1])
  if (!sorted.length) return { text: '_Nobody scored._', mentions: [] }
  const medals = ['🥇', '🥈', '🥉']
  const lines = sorted.map(([user, score], i) => `${medals[i] ?? `${i + 1}.`} ${tag(user)} — *${score}*`)
  return { text: lines.join('\n'), mentions: sorted.map(([u]) => u) }
}

async function wrgFinish(chat: string, game: WrgGame) {
  clearGame(chat, game)
  const { text, mentions } = wrgScoreboard(game)
  await game.last.send(`🏁 Game over!\n\n🏆 *Scoreboard*\n${text}`, { mentions })
}

command(
  {
    name: 'wrg',
    desc: 'Random word game: first to send a real word containing the given letters scores',
    usage: 'start [rounds] | end',
    category: 'game',
    groupOnly: true,
    public: true,
  },
  async (msg, args) => {
    const [sub, roundsArg] = args.trim().toLowerCase().split(/\s+/)
    const game = games.get(msg.chat)

    if (sub === 'end') {
      if (!game) return msg.reply('_No word game is running here._')
      return endAny(msg, game)
    }

    if (sub && sub !== 'start') return msg.reply('_Usage: wrg start [rounds] · wrg end_')
    if (game) return msg.reply(game.kind === 'wcg' ? '_A word chain game is running here. End it first._' : '_A random word game is already running here. Use *wrg end* to stop it._')

    const rounds = Math.min(50, Math.max(1, Number(roundsArg) || WRG_DEFAULT_ROUNDS))
    const fresh: WrgGame = { kind: 'wrg', rounds, round: 0, fragment: '', example: '', scores: new Map(), last: msg, timers: [] }
    games.set(msg.chat, fresh)
    await msg.reply(`🎮 Random Word Game — ${rounds} rounds\nFirst correct word containing the given letters scores a point. Go!`)
    await wrgNextRound(msg.chat, fresh)
  },
)

async function wrgOnText(chat: string, game: WrgGame, msg: Message) {
  if (!game.fragment) return
  const text = msg.text.trim().toLowerCase()
  if (!/^[a-z]+$/.test(text) || !text.includes(game.fragment)) return
  if (!isWord(text)) return msg.react('❌').catch(() => {})

  for (const t of game.timers) clearTimeout(t)
  game.timers = []
  game.fragment = ''
  game.last = msg
  const key = msg.sender
  game.scores.set(key, (game.scores.get(key) ?? 0) + 1)
  await msg.react('✅').catch(() => {})
  await msg.reply(`✅ ${tag(key)} got it with *${text}*! (+1 → ${game.scores.get(key)})`, { mentions: [key] })
  later(chat, game, 2000, () => wrgNextRound(chat, game))
}

// One listener for both games. No fromMe filter so the bot owner can play too.
on(
  'text',
  async (msg) => {
    const game = games.get(msg.chat)
    if (!game) return
    if (isCommandText(msg.text)) return
    if (game.kind === 'wcg') return wcgOnText(msg.chat, game, msg)
    return wrgOnText(msg.chat, game, msg)
  },
  { groupOnly: true, name: 'wordgames' },
)
