// Minimal HLS playlist parsing for the WebCodecs player. The proxy already
// rewrites every segment/URI to /api/proxy?u=... so we only need to read
// structure, not resolve URLs.

export interface Segment {
  seq: number;
  url: string;
  duration: number;
}

export interface MediaPlaylist {
  kind: 'media';
  mediaSequence: number;
  targetDuration: number;
  segments: Segment[];
  /** true when there is no #EXT-X-ENDLIST (i.e. a live playlist). */
  live: boolean;
}

export interface MasterPlaylist {
  kind: 'master';
  /** Variant playlist URLs in declaration order. */
  variants: { url: string; bandwidth: number }[];
}

export type Playlist = MediaPlaylist | MasterPlaylist;

export function parsePlaylist(text: string): Playlist {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  if (lines.some((l) => l.startsWith('#EXT-X-STREAM-INF'))) {
    return parseMaster(lines);
  }
  return parseMediaPlaylist(text);
}

function parseMaster(lines: string[]): MasterPlaylist {
  const variants: { url: string; bandwidth: number }[] = [];
  let pendingBw = 0;
  for (const line of lines) {
    if (line.startsWith('#EXT-X-STREAM-INF')) {
      const m = /BANDWIDTH=(\d+)/.exec(line);
      pendingBw = m ? Number(m[1]) : 0;
    } else if (line && !line.startsWith('#')) {
      variants.push({ url: line, bandwidth: pendingBw });
      pendingBw = 0;
    }
  }
  return { kind: 'master', variants };
}

export function parseMediaPlaylist(text: string): MediaPlaylist {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  let mediaSequence = 0;
  let targetDuration = 0;
  let live = true;
  let pendingDuration = 0;
  const segments: Segment[] = [];
  let index = 0;

  for (const line of lines) {
    if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
      mediaSequence = Number(line.split(':')[1]) || 0;
    } else if (line.startsWith('#EXT-X-TARGETDURATION:')) {
      targetDuration = Number(line.split(':')[1]) || 0;
    } else if (line.startsWith('#EXT-X-ENDLIST')) {
      live = false;
    } else if (line.startsWith('#EXTINF:')) {
      pendingDuration = parseFloat(line.slice('#EXTINF:'.length)) || 0;
    } else if (line && !line.startsWith('#')) {
      segments.push({ seq: mediaSequence + index, url: line, duration: pendingDuration });
      pendingDuration = 0;
      index++;
    }
  }
  return { kind: 'media', mediaSequence, targetDuration, segments, live };
}

/** Segments in `p` newer than `lastSeq` (used to poll a live playlist without re-fetching old segments). */
export function diffNewSegments(p: MediaPlaylist, lastSeq: number): Segment[] {
  return p.segments.filter((s) => s.seq > lastSeq);
}
