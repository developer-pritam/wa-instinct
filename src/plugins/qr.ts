import jsQRModule from 'jsqr'
import QRCode from 'qrcode'
import sharp from 'sharp'
import { command } from '../core/index.js'

// jsqr ships a UMD build whose module.exports is the function itself, but its typings declare a default export
type JsQR = typeof jsQRModule.default
const jsQR: JsQR = ((jsQRModule as { default?: JsQR }).default ?? jsQRModule) as unknown as JsQR

command(
  {
    name: 'qr',
    desc: 'Make a QR code from text, or read one from a replied image',
    usage: '<text> | <reply to image>',
    category: 'misc',
  },
  async (msg, args) => {
    if (args) {
      const image = await QRCode.toBuffer(args, { type: 'png', width: 512, margin: 2 })
      return msg.reply({ image, caption: args.length > 100 ? undefined : args })
    }
    if (!msg.quoted?.isImage) return msg.reply('_Usage: qr <text> | reply to a QR image with qr_')

    const buf = await msg.quoted.download()
    const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
    const pixels = new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength)
    const result = jsQR(pixels, info.width, info.height)
    if (!result?.data) return msg.reply('_No QR code found in that image._')
    await msg.reply(result.data)
  },
)
