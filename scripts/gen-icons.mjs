// 从 public/avatars/icon.png 生成 @capacitor/assets 自定义模式所需的三个源图，
// 随后由 `capacitor-assets generate --android` 生成各密度 mipmap。
// - icon-only.png：原图满幅，用于旧版方形/圆形启动图标（启动器自动圆角）。
// - icon-foreground.png：原图缩放到自适应安全区（72%）并居中，避免圆形遮罩裁掉主体。
// - icon-background.png：纯白底，与图标白色背景无缝衔接。
import sharp from 'sharp'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = resolve(root, 'public/avatars/icon.png')
const OUT = resolve(root, 'assets')
const SIZE = 1024

const run = async () => {
  // 图标为满幅设计（白底、四角白色）。前景与旧版图标均用满幅原图，
  // 自适应遮罩只会裁掉白色边角。背景层用纯白，与图标白底无缝。
  await sharp(SRC).resize(SIZE, SIZE, { fit: 'cover' }).png().toFile(resolve(OUT, 'icon-only.png'))
  await sharp(SRC).resize(SIZE, SIZE, { fit: 'cover' }).png().toFile(resolve(OUT, 'icon-foreground.png'))
  await sharp({ create: { width: SIZE, height: SIZE, channels: 3, background: { r: 255, g: 255, b: 255 } } })
    .png().toFile(resolve(OUT, 'icon-background.png'))

  console.log('icon sources written to assets/: icon-only.png, icon-foreground.png, icon-background.png')
}

run().catch(error => { console.error(error); process.exit(1) })
