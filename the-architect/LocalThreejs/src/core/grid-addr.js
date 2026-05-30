// core/grid-addr.js
// Address conversions for the 100x100 grid.
//
// Convention (locked):
//   - rowId is letter-then-digit: A0..A9, B0..B9, ..., J0..J9   (10 letters × 10 digits = 100)
//   - col is plain integer 1..100
//   - rowIndex(0..99) = (letter-'A')*10 + digit
//   - colIndex(0..99) = col - 1
//
// World mapping (3D engine):
//   - X axis = column direction. col=1 maps to X=0; col=N maps to X=(N-1)*cellSize.
//   - Z axis = row direction. row=A0 maps to Z=0; row=N maps to Z=N*cellSize.
//     (Three.js +Z is toward camera in default orientation; we use +Z as "south"
//      because the grid reads top-to-bottom A0 → J9.)

const LETTERS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'];

export function rowIdToIndex(rowId) {
  if (typeof rowId !== 'string' || rowId.length !== 2) return null;
  const letter = rowId[0].toUpperCase();
  const digit = parseInt(rowId[1], 10);
  if (!LETTERS.includes(letter) || isNaN(digit)) return null;
  return LETTERS.indexOf(letter) * 10 + digit;
}

export function indexToRowId(rowIndex) {
  if (rowIndex < 0 || rowIndex > 99) return null;
  const letter = LETTERS[Math.floor(rowIndex / 10)];
  const digit  = rowIndex % 10;
  return `${letter}${digit}`;
}

export function cellToWorld(rowId, col, cellSize = 1) {
  const r = rowIdToIndex(rowId);
  if (r === null || col < 1 || col > 100) return null;
  // World position is the CENTER of the cell.
  return {
    x: (col - 1 + 0.5) * cellSize,
    z: (r + 0.5) * cellSize,
  };
}

export function worldToCell(x, z, cellSize = 1) {
  const colIndex = Math.floor(x / cellSize);
  const rowIndex = Math.floor(z / cellSize);
  if (colIndex < 0 || colIndex > 99 || rowIndex < 0 || rowIndex > 99) return null;
  return { rowId: indexToRowId(rowIndex), col: colIndex + 1 };
}

// Generate all rowIds in order for editor headers / iteration.
export function allRowIds() {
  const out = [];
  for (const L of LETTERS) for (let d = 0; d < 10; d++) out.push(`${L}${d}`);
  return out;
}
