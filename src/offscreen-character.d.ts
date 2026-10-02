export interface OffscreenCharacterOptions {
  modelUrl: string;
  indexUrl: string;
  runtime: unknown;
  width?: number;
  height?: number;
  /** Fixed view height and vertical center in model world units (meters). */
  framing?: { viewHeight: number; centerY: number; groupOffsets?: Record<string, number> };
}
export class OffscreenCharacter {
  static create(options: OffscreenCharacterOptions): Promise<OffscreenCharacter>;
  static preload(options: OffscreenCharacterOptions): Promise<void>;
  static preloadNamed(indexUrl: string, requests: Array<{ kind: 'motion' | 'expression'; name: string }>): Promise<void>;
  static takePreloaded(options: OffscreenCharacterOptions): Promise<OffscreenCharacter | null>;
  canvas: HTMLCanvasElement;
  setMotion(name: string): Promise<void>;
  setExpression(name: string): Promise<void>;
  setBlinkParameters(config: Partial<{ blinkInterval: number; blinkIntervalRandom: number;
    closingDuration: number; closedDuration: number; openingDuration: number }>): void;
  setMouth(value: number | null): void;
  update(delta: number): void;
  dispose(): void;
}
