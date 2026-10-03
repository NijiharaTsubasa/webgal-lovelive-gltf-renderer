export interface OffscreenCharacterOptions {
  modelUrl: string;
  indexUrl: string;
  runtime: unknown;
  width?: number;
  height?: number;
  /** Initial playback state, prepared at time zero before the instance is returned. */
  motion?: string;
  expression?: string;
  /** Stable identity of one anticipated appearance; distinct appearances use distinct IDs. */
  preloadId?: string;
  /** Fixed view height and vertical center in model world units (meters). */
  framing?: { viewHeight: number; centerY: number; groupOffsets?: Record<string, number> };
}
export class OffscreenCharacter {
  static create(options: OffscreenCharacterOptions): Promise<OffscreenCharacter>;
  static preload(options: OffscreenCharacterOptions): Promise<void>;
  static setPreloadRequests(options: OffscreenCharacterOptions[]): Promise<void>;
  static preloadNamed(indexUrl: string, requests: Array<{ kind: 'motion' | 'expression'; name: string }>): Promise<void>;
  static takePreloaded(options: OffscreenCharacterOptions): Promise<OffscreenCharacter | null>;
  canvas: HTMLCanvasElement;
  setMotion(name: string): Promise<void>;
  setExpression(name: string): Promise<void>;
  /** Flush pending state and prepare rendering while the host freezes the actor's ticker. */
  prepare(): Promise<void>;
  setBlinkParameters(config: Partial<{ blinkInterval: number; blinkIntervalRandom: number;
    closingDuration: number; closedDuration: number; openingDuration: number }>): void;
  setMouth(value: number | null): void;
  update(delta: number): void;
  dispose(): void;
}
