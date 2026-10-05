export interface HostResourceEntry {
  type: string;
  name: string;
  config: string;
  component: Record<string, any>;
  basePath: string;
  motionGroup?: string;
}
/** Host-owned resource lookup, shared by preparation and playback. */
export interface CharacterResourceCatalog {
  entries: Array<{ type: string; name: string; config: string }>;
  fetch(url: string, kind?: 'json' | 'bytes'): Promise<any>;
  response(url: string): Promise<Response>;
  model(configUrl: string): Promise<HostResourceEntry>;
  preloadModelDependencies(model: HostResourceEntry): Promise<void>;
  resolveMotion(name: string, options?: { optional?: boolean }): Promise<HostResourceEntry | null | undefined>;
  resolveExpression(name: string, options?: { optional?: boolean }): Promise<HostResourceEntry | null | undefined>;
}
export interface OffscreenCharacterOptions {
  surface?: CharacterRenderSurface;
  modelUrl: string;
  indexUrl: string;
  /** Ready resource lookup supplied by the host; indexUrl identifies its resource scope. */
  resourceCatalog?: CharacterResourceCatalog;
  runtime: unknown;
  /** Create mesh cloth simulation; defaults to true. Bone physics remains available. */
  meshClothEnabled?: boolean;
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
  static preloadNamed(indexUrl: string, requests: Array<{ kind: 'motion' | 'expression'; name: string }>, resourceCatalog?: CharacterResourceCatalog): Promise<void>;
  static takePreloaded(options: OffscreenCharacterOptions): Promise<OffscreenCharacter | null>;
  canvas: HTMLCanvasElement;
  setMotion(name: string): Promise<void>;
  /** Native: 3d:<encoded eye>/<encoded closed>/<encoded open>; empty selects the model default. */
  setExpression(name: string): Promise<void>;
  /** Flush pending state and prepare rendering while the host freezes the actor's ticker. */
  prepare(): Promise<void>;
  setBlinkParameters(config: Partial<{ blinkInterval: number; blinkIntervalRandom: number;
    closingDuration: number; closedDuration: number; openingDuration: number }>): void;
  setMouth(value: number | null): void;
  update(delta: number): void;
  dispose(): void;
}

/** A context shared by independently prepared actors; the host uploads its canvas. */
export class CharacterRenderSurface {
  constructor(options?: { width?: number; height?: number });
  canvas: HTMLCanvasElement;
  width: number;
  height: number;
  disposed: boolean;
  activate(actor: OffscreenCharacter): void;
  deactivate(actor?: OffscreenCharacter): void;
  dispose(): void;
}
