/**
 * models.js — Claude-modeller för AI-igenkänning (Premium).
 * Standardmodellen är hårdkodad HÄR och bara här.
 */

export const STANDARD_MODELL = 'claude-sonnet-5-5';

/** Valbara modeller i Inställningar. */
export const MODELLER = Object.freeze([
  { id: 'claude-sonnet-5-5', namn: 'Sonnet', beskrivning: 'Rekommenderas. Bra balans mellan noggrannhet och kostnad.' },
  { id: 'claude-opus-5-5', namn: 'Opus', beskrivning: 'Mest noggrann. Kostar mer per tenta.' },
  { id: 'claude-haiku-5-5', namn: 'Haiku', beskrivning: 'Snabbast och billigast. Kan missa svåra layouter.' },
]);
