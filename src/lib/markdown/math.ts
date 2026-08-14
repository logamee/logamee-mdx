function isEscapedAt(src: string, index: number): boolean {
  let slashCount = 0;
  for (let i = index - 1; i >= 0 && src[i] === '\\'; i -= 1) slashCount += 1;
  return slashCount % 2 === 1;
}

function normalizeMathInner(inner: string): string {
  return inner.replace(/\\\\\\\\/g, '\\\\').replace(/\\\\([A-Za-z])/g, '\\$1');
}

function findClosingInlineMathDollar(src: string, start: number): number {
  for (let i = start + 1; i < src.length; i += 1) {
    if (src[i] === '\n') return -1;
    if (src[i] !== '$' || isEscapedAt(src, i)) continue;
    if (src[i + 1] === '$') return -1;
    return i;
  }
  return -1;
}

function findClosingDisplayMathDollar(src: string, start: number): number {
  for (let i = start + 2; i < src.length - 1; i += 1) {
    if (src[i] === '$' && src[i + 1] === '$' && !isEscapedAt(src, i)) return i;
  }
  return -1;
}

function isLikelyDigitStartedMath(inner: string): boolean {
  return /\\[A-Za-z]+|[=+*/^_<>≤≥≈≠×÷{}]/.test(inner) || /\d[A-Za-z]|[A-Za-z]\d/.test(inner) || /^\d+(?:\.\d+)?\s+[A-Za-z](?:\s|$|[=+*/^_<>≤≥≈≠×÷{}])/.test(inner);
}

function shouldTreatAsInlineMath(src: string, start: number, end: number): boolean {
  const inner = src.slice(start + 1, end);
  if (!inner || /\s/.test(src[start + 1] ?? '') || /\s/.test(src[end - 1] ?? '')) return false;
  if (/\d/.test(src[start + 1] ?? '')) return isLikelyDigitStartedMath(inner);
  return true;
}

export function escapeCurrencyDollarSigns(src: string): string {
  let output = '';
  for (let i = 0; i < src.length; i += 1) {
    if (src[i] !== '$' || isEscapedAt(src, i)) {
      output += src[i];
      continue;
    }
    if (src[i + 1] === '$') {
      output += '$$';
      i += 1;
      continue;
    }
    if (/\d/.test(src[i + 1] ?? '')) {
      const close = findClosingInlineMathDollar(src, i);
      output += close >= 0 && shouldTreatAsInlineMath(src, i, close) ? '$' : '\\$';
      continue;
    }
    output += src[i];
  }
  return output;
}

export function normalizeDoubleBackslashesInMathDelimiters(src: string): string {
  const source = escapeCurrencyDollarSigns(src);
  let output = '';
  for (let i = 0; i < source.length; i += 1) {
    if (source[i] !== '$' || isEscapedAt(source, i)) {
      output += source[i];
      continue;
    }
    if (source[i + 1] === '$') {
      const close = findClosingDisplayMathDollar(source, i);
      if (close >= 0) {
        output += '$$' + normalizeMathInner(source.slice(i + 2, close)) + '$$';
        i = close + 1;
        continue;
      }
    } else {
      const close = findClosingInlineMathDollar(source, i);
      if (close >= 0 && shouldTreatAsInlineMath(source, i, close)) {
        output += '$' + normalizeMathInner(source.slice(i + 1, close)) + '$';
        i = close;
        continue;
      }
    }
    output += source[i];
  }
  return output;
}
