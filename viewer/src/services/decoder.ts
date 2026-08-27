import { inflate } from 'pako';
import type { RRWebEvent } from '../types';

export function decodeEventData(eventData: string): RRWebEvent | null {
  try {
    const binary = atob(eventData);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    const json = inflate(bytes, { toText: true });
    return JSON.parse(json) as RRWebEvent;
  } catch {
    // Some eventData rows may not be compressed — try plain base64 JSON
    try {
      return JSON.parse(atob(eventData)) as RRWebEvent;
    } catch {
      return null;
    }
  }
}
