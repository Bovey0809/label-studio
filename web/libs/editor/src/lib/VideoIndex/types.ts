export interface DensePayload {
  content_key: string;
  frame_count: number;
  duration: number;
  codec: string;
  width?: number;
  height?: number;
  pts: number[];
}

export interface CfrPayload {
  content_key: string;
  frame_count: number;
  duration: number;
  codec: string;
  width?: number;
  height?: number;
  cfr: { fps: number; count?: number };
}

export type IndexPayload = DensePayload | CfrPayload;
