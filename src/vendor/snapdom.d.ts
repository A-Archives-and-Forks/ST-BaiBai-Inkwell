/** vendored @zumer/snapdom v2.22.0 的最小类型面(只声明我们用到的部分) */

export interface SnapdomOptions {
  scale?: number;
  dpr?: number;
  backgroundColor?: string | null;
  embedFonts?: boolean;
  compress?: boolean;
  useProxy?: string;
  fallbackURL?: string;
  quality?: number;
  width?: number;
  height?: number;
  cache?: string | boolean;
  filter?: (el: Element) => boolean;
  exclude?: string[];
}

export interface SnapdomResult {
  toPng(options?: SnapdomOptions): Promise<HTMLImageElement>;
  toCanvas(options?: SnapdomOptions): Promise<HTMLCanvasElement>;
  toBlob(options?: SnapdomOptions & { type?: string }): Promise<Blob>;
  download(options?: SnapdomOptions & { format?: string; filename?: string }): Promise<void>;
  url: string;
}

export interface SnapdomFn {
  (el: Element, options?: SnapdomOptions): Promise<SnapdomResult>;
  capture(el: Element, options?: SnapdomOptions): Promise<SnapdomResult>;
  toPng(el: Element, options?: SnapdomOptions): Promise<HTMLImageElement>;
  toCanvas(el: Element, options?: SnapdomOptions): Promise<HTMLCanvasElement>;
  toBlob(el: Element, options?: SnapdomOptions & { type?: string }): Promise<Blob>;
  download(el: Element, options?: SnapdomOptions & { format?: string; filename?: string }): Promise<void>;
}

export declare const snapdom: SnapdomFn;
export declare function preCache(root?: Document | Element, options?: SnapdomOptions): Promise<void>;
