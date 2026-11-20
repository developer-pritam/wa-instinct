import { command, config, jid, on, type Message } from '../core/index.js'

type Mark = 'X' | 'O'

interface Game {
  /** Player jids (phone-number form). X always starts. */
  x: string
  o: string
  board: (Mark | null)[]
  turn: Mark
  /** Last message in this chat, used to send timeout notices. */
  last: Message
  timer?: NodeJS.Timeout
}

const games = new Map<string, Game>()
const INACTIVITY_MS = 10 * 60 * 1000
const CELLS = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣']
const MARKS: Record<Mark, string> = { X: '❌', O: '⭕' }
const LINES = [
  [0, 1, 2], [3, 4, 5], [6, 7, 8], // rows
  [0, 3, 6], [1, 4, 7], [2, 5, 8], // columns
  [0, 4, 8], [2, 4, 6], // diagonals
]

const tag = (user: string) => `@${jid.toNumber(user)}`
const isCommandText = (text: string) => {
  const first = text.trim()[0]
  return !!first && config.prefix.includes(first)
}

function renderBoard(game: Game): string {
  const rows: string[] = []
  for (let r = 0; r < 3; r++) {
    rows.push(game.board.slice(r * 3, r * 3 + 3).map((m, i) => (m ? MARKS[m] : CELLS[r * 3 + i])).join(''))
  }
  return rows.join('\n')
}

const player = (game: Game, mark: Mark) => (mark === 'X' ? game.x : game.o)

function status(game: Game): string {
  const current = player(game, game.turn)
  return [
    '*--- Tic Tac Toe ---*',
    '',
    renderBoard(game),
    '',
    `❌ ${tag(game.x)}  vs  ⭕ ${tag(game.o)}`,
    `🎲 Turn: ${MARKS[game.turn]} ${tag(current)}`,
    '_Send a number (1-9) to play._',
  ].join('\n')
}

function winner(board: (Mark | null)[]): Mark | undefined {
  for (const [a, b, c] of LINES) {
    if (board[a] && board[a] === board[b] && board[a] === board[c]) return board[a]!
  }
  return undefined
}

function endGame(chat: string) {
  const game = games.get(chat)
  if (!game) return false
  clearTimeout(game.timer)
  games.delete(chat)
  return true
}

/** (Re)arm the inactivity timer; the game is dropped quietly if nobody moves for 10 minutes. */
function touch(chat: string, game: Game, last: Message) {
  clearTimeout(game.timer)
  game.last = last
  game.timer = setTimeout(() => {
    if (games.get(chat) !== game) return
    games.delete(chat)
    game.last
      .send(`⏰ Tic-tac-toe between ${tag(game.x)} and ${tag(game.o)} ended due to inactivity.`, { mentions: [game.x, game.o] })
      .catch(() => {})
  }, INACTIVITY_MS)
}

command(
  {
    name: 'tictactoe',
    aliases: ['ttt'],
    desc: 'Play tic-tac-toe with someone. Players move by sending a number 1-9',
    usage: '<@opponent | reply> | board | end',
    category: 'game',
    groupOnly: true,
    public: true,
  },
  async (msg, args) => {
    const sub = args.trim().toLowerCase()
    const game = games.get(msg.chat)

    if (sub === 'end') {
      if (!game) return msg.reply('_No tic-tac-toe game is running here._')
      const isPlayer = (await msg.jids.same(msg.sender, game.x)) || (await msg.jids.same(msg.sender, game.o))
      if (!isPlayer && !msg.isSudo) return msg.reply('_Only the players can end this game._')
      endGame(msg.chat)
      return msg.reply('🏁 Game ended.')
    }

    if (sub === 'board') {
      if (!game) return msg.reply('_No tic-tac-toe game is running here._')
      return msg.reply(status(game), { mentions: [game.x, game.o] })
    }

    if (game) return msg.reply(`_A game is already running here between ${tag(game.x)} and ${tag(game.o)}. Use *tictactoe end* to stop it._`, { mentions: [game.x, game.o] })

    const target = msg.targetUser ?? jid.parseJids(args)[0]
    if (!target) return msg.reply('_Usage: tictactoe @opponent | reply_')
    const opponent = await msg.jids.toPn(target)
    if (await msg.jids.same(opponent, msg.sender)) return msg.reply("_You can't play against yourself._")

    const fresh: Game = {
      x: msg.sender,
      o: opponent,
      board: Array(9).fill(null),
      turn: 'X',
      last: msg,
    }
    games.set(msg.chat, fresh)
    touch(msg.chat, fresh, msg)
    await msg.reply(status(fresh), { mentions: [fresh.x, fresh.o] })
  },
)

// Moves: a bare digit 1-9 from one of the players. No fromMe filter so the bot owner can play too.
on(
  'text',
  async (msg) => {
    const game = games.get(msg.chat)
    if (!game) return
    const text = msg.text.trim()
    if (!/^[1-9]$/.test(text) || isCommandText(text)) return

    const current = player(game, game.turn)
    if (!(await msg.jids.same(msg.sender, current))) {
      const other = player(game, game.turn === 'X' ? 'O' : 'X')
      if (await msg.jids.same(msg.sender, other)) await msg.reply(`_Not your turn. Waiting for ${tag(current)}._`, { mentions: [current] })
      return
    }

    const cell = Number(text) - 1
    if (game.board[cell]) return msg.reply('_Already occupied._')
    game.board[cell] = game.turn
    touch(msg.chat, game, msg)

    const won = winner(game.board)
    if (won) {
      endGame(msg.chat)
      return msg.reply(`*--- Tic Tac Toe ---*\n\n${renderBoard(game)}\n\n🏁 Game finish!\n🏆 Winner: ${MARKS[won]} ${tag(player(game, won))}`, { mentions: [game.x, game.o] })
    }
    if (game.board.every(Boolean)) {
      endGame(msg.chat)
      return msg.reply(`*--- Tic Tac Toe ---*\n\n${renderBoard(game)}\n\n🏁 Game finish!\n🤝 It's a draw, ${tag(game.x)} and ${tag(game.o)}.`, { mentions: [game.x, game.o] })
    }

    game.turn = game.turn === 'X' ? 'O' : 'X'
    await msg.reply(status(game), { mentions: [game.x, game.o] })
  },
  { groupOnly: true, name: 'tictactoe' },
)
