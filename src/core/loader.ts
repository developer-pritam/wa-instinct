import { readdirSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { PLUGINS_DIR } from '../config.js'
import { logger } from './logger.js'
import { commands, setCurrentPlugin } from './registry.js'

/** Import every file in src/plugins so their `command()` / `on()` calls register. */
export async function loadPlugins(): Promise<string[]> {
  const files = readdirSync(PLUGINS_DIR)
    .filter((f) => /\.(ts|js)$/.test(f) && !f.startsWith('_') && !f.endsWith('.d.ts'))
    .sort()
  const loaded: string[] = []
  for (const file of files) {
    const name = file.replace(/\.(ts|js)$/, '')
    setCurrentPlugin(name)
    try {
      await import(pathToFileURL(path.join(PLUGINS_DIR, file)).href)
      loaded.push(name)
    } catch (err) {
      logger.error({ err, plugin: name }, 'plugin failed to load')
    }
  }
  setCurrentPlugin(undefined)
  logger.info(`loaded ${loaded.length} plugins, ${commands.length} commands`)
  return loaded
}
