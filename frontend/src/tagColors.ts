import type { CSSProperties } from 'react';
import type { TagColors } from './api';

export const TAG_PALETTE = [
  { color: '#9cc4ff', label: '파랑' },
  { color: '#70dbc0', label: '민트' },
  { color: '#c8a6ff', label: '보라' },
  { color: '#ff9fc3', label: '분홍' },
  { color: '#ffb477', label: '주황' },
  { color: '#f5d574', label: '노랑' },
  { color: '#a6da85', label: '연두' },
  { color: '#7bd9ec', label: '하늘' },
];

export function getTagColor(colors: TagColors | undefined, tag: string) {
  return colors && Object.prototype.hasOwnProperty.call(colors, tag) ? colors[tag] : null;
}

export function tagColorStyle(tag: string, color: string | null = null): CSSProperties {
  if (color === null) {
    let hash = 0;
    for (let index = 0; index < tag.length; index++) {
      hash = (Math.imul(hash, 31) + tag.charCodeAt(index)) >>> 0;
    }
    color = TAG_PALETTE[hash % TAG_PALETTE.length].color;
  }
  return { '--tag-color': color } as CSSProperties;
}
