// Typed wrapper around troika-three-text (which ships no TypeScript types).
// Troika normally resolves glyph fonts from a CDN at runtime — blocked by our
// CSP and useless offline — so every Text is pinned to a bundled local font.
import * as THREE from 'three'
import { Text as TroikaText, configureTextBuilder } from 'troika-three-text'
// ?inline → data: URI; fetch() cannot load file:// URLs in the packaged app
import labelFontUrl from './assets/label-font.ttf?inline'

// troika's typesetting worker boots from a blob: script, which our CSP
// (script-src 'self') blocks — typeset on the main thread instead. Our label
// counts are small, so this is milliseconds of one-off work.
configureTextBuilder({ useWorker: false })

export interface TextMesh extends THREE.Mesh {
  text: string
  font: string | null
  fontSize: number
  color: number | string
  outlineWidth: number
  outlineColor: number | string
  anchorX: 'left' | 'center' | 'right' | number
  anchorY: string | number
  sync(callback?: () => void): void
  dispose(): void
}

const TroikaTextCtor = TroikaText as new () => TextMesh

export class Text extends TroikaTextCtor {
  constructor() {
    super()
    this.font = labelFontUrl
  }
}
