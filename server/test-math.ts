const superscriptDigits: Record<string, string> = {
  '⁰': '0',
  '¹': '1',
  '²': '2',
  '³': '3',
  '⁴': '4',
  '⁵': '5',
  '⁶': '6',
  '⁷': '7',
  '⁸': '8',
  '⁹': '9',
  '⁺': '+',
  '⁻': '-',
};

const latexSymbols: Record<string, string> = {
  '−': '-',
  '×': '\\times',
  '÷': '\\div',
  '≤': '\\leq',
  '≥': '\\geq',
  '≠': '\\ne',
  '≈': '\\approx',
  '±': '\\pm',
  'π': '\\pi',
  'θ': '\\theta',
  '°': '^{\\circ}',
};

const mathSignal = /[√⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻−×÷≤≥≠≈±πθ°]/;
const asciiMathStart = /[A-Za-z0-9(+\-−±]/;

type ParseResult = { end: number; hasMathSignal: boolean };
type Quote = { open: string; close: string };

const quotePairs: Record<string, string> = {
  '"': '"',
  '“': '”',
  '‘': '’',
  '«': '»',
};

function isEscaped(value: string, index: number): boolean {
  let slashes = 0;
  for (let cursor = index - 1; cursor >= 0 && value[cursor] === '\\'; cursor -= 1) slashes += 1;
  return slashes % 2 === 1;
}

function quoteAt(value: string, index: number): Quote | null {
  const char = value[index];
  if (!char) return null;
  const close = quotePairs[char];
  if (close && !isEscaped(value, index)) return { open: char, close };
  if (char === "'" && !isEscaped(value, index) && (index === 0 || /[\s([{,:;]/.test(value[index - 1] ?? ''))) {
    return { open: char, close: char };
  }
  return null;
}

function findQuoteEnd(value: string, start: number, quote: Quote): number {
  for (let index = start + quote.open.length; index <= value.length - quote.close.length; index += 1) {
    if (value.startsWith(quote.close, index) && !isEscaped(value, index)) return index + quote.close.length;
  }
  return value.length;
}

function findClosing(value: string, openIndex: number): number {
  const open = value[openIndex];
  const close = open === '(' ? ')' : open === '[' ? ']' : open === '{' ? '}' : '';
  if (!close) return -1;
  let depth = 0;
  for (let index = openIndex; index < value.length; index += 1) {
    if (value[index] === open) depth += 1;
    else if (value[index] === close) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function skipWhitespace(value: string, index: number): number {
  while (index < value.length && /\s/.test(value[index] ?? '')) index += 1;
  return index;
}

function parseAtom(value: string, start: number): ParseResult | null {
  const char = value[start];
  if (!char) return null;

  if (char === '√') {
    const argumentStart = skipWhitespace(value, start + 1);
    if (value[argumentStart] === '(') {
      const close = findClosing(value, argumentStart);
      return close < 0 ? null : { end: close + 1, hasMathSignal: true };
    }
    const argument = parseAtom(value, argumentStart);
    return argument ? { end: argument.end, hasMathSignal: true } : null;
  }

  if (char === '(' || char === '[') {
    const close = findClosing(value, start);
    if (close < 0) return null;
    const inner = parseExpression(value, start + 1);
    const innerEnd = skipWhitespace(value, inner.end);
    if (innerEnd !== close) return null;
    return { end: close + 1, hasMathSignal: inner.hasMathSignal };
  }

  let end = start;
  let hasMathSignal = false;
  if (/\d/.test(char)) {
    end += 1;
    while (end < value.length && /\d/.test(value[end] ?? '')) end += 1;
    if (value[end] === '.' && /\d/.test(value[end + 1] ?? '')) {
      end += 1;
      while (end < value.length && /\d/.test(value[end] ?? '')) end += 1;
    }
  } else if (/[A-Za-z]/.test(char) || char === 'π' || char === 'θ') {
    end += 1;
    hasMathSignal = char === 'π' || char === 'θ';
  } else {
    return null;
  }

  while (end < value.length && Object.hasOwn(superscriptDigits, value[end] ?? '')) {
    end += 1;
    hasMathSignal = true;
  }
  if (value[end] === '°') {
    end += 1;
    hasMathSignal = true;
  }
  return { end, hasMathSignal };
}

function parseSignedAtom(value: string, start: number): ParseResult | null {
  const char = value[start];
  if (char && '+-−±'.includes(char)) {
    const atomStart = skipWhitespace(value, start + 1);
    const atom = parseAtom(value, atomStart);
    return atom ? {
      end: atom.end,
      hasMathSignal: atom.hasMathSignal || char === '−' || char === '±',
    } : null;
  }
  return parseAtom(value, start);
}

function readOperator(value: string, index: number): { value: string; end: number; hasMathSignal: boolean } | null {
  const twoChar = value.slice(index, index + 2);
  if (['<=', '>=', '!='].includes(twoChar)) return { value: twoChar, end: index + 2, hasMathSignal: false };
  const char = value[index];
  if (char && '=<>+-−×÷≤≥≠≈±*/'.includes(char)) {
    return { value: char, end: index + 1, hasMathSignal: Object.hasOwn(latexSymbols, char) };
  }
  return null;
}

function parseExpression(value: string, start: number): ParseResult {
  const first = parseSignedAtom(value, start);
  if (!first) return { end: start, hasMathSignal: false };

  let end = first.end;
  let hasMathSignal = first.hasMathSignal;
  while (end < value.length) {
    const operatorStart = skipWhitespace(value, end);
    const operator = readOperator(value, operatorStart);
    if (!operator) {
      if (operatorStart === end) {
        const adjacentAtom = parseAtom(value, end);
        const adjacentHasSignal = adjacentAtom ? mathSignal.test(value.slice(end, adjacentAtom.end)) : false;
        if (adjacentAtom && (hasMathSignal || adjacentAtom.hasMathSignal || adjacentHasSignal)) {
          end = adjacentAtom.end;
          hasMathSignal ||= adjacentAtom.hasMathSignal;
          continue;
        }
      }
      break;
    }
    const operandStart = skipWhitespace(value, operator.end);
    const operand = parseSignedAtom(value, operandStart);
    if (!operand) break;
    end = operand.end;
    hasMathSignal ||= operator.hasMathSignal || operand.hasMathSignal;
  }
  return { end, hasMathSignal };
}

function parseRootArgument(value: string, start: number): { content: string; end: number } | null {
  const argumentStart = skipWhitespace(value, start);
  const char = value[argumentStart];
  if (char === '(') {
    const close = findClosing(value, argumentStart);
    return close < 0 ? null : { content: value.slice(argumentStart + 1, close), end: close + 1 };
  }
  const argument = char ? parseAtom(value, argumentStart) : null;
  return argument ? { content: value.slice(argumentStart, argument.end), end: argument.end } : null;
}

function controlSequenceEnd(value: string, start: number): number {
  let end = start + 1;
  if (/[A-Za-z]/.test(value[end] ?? '')) {
    while (end < value.length && /[A-Za-z]/.test(value[end] ?? '')) end += 1;
  } else if (end < value.length) {
    end += 1;
  }
  return end;
}

function skipTextCommand(value: string, start: number, commandEnd: number): number | null {
  const command = value.slice(start + 1, commandEnd);
  if (!['text', 'textbf', 'textit', 'textrm', 'textsf', 'texttt', 'textnormal', 'mbox'].includes(command)) return null;
  const argumentStart = skipWhitespace(value, commandEnd);
  if (value[argumentStart] !== '{') return null;
  const close = findClosing(value, argumentStart);
  return close < 0 ? null : close + 1;
}

function convertMathContent(value: string): string {
  let output = '';
  for (let index = 0; index < value.length;) {
    const quote = quoteAt(value, index);
    if (quote) {
      const quoteEnd = findQuoteEnd(value, index, quote);
      output += value.slice(index, quoteEnd);
      index = quoteEnd;
      continue;
    }
    if (value[index] === '\\') {
      const commandEnd = controlSequenceEnd(value, index);
      const textEnd = skipTextCommand(value, index, commandEnd);
      const end = textEnd ?? commandEnd;
      output += value.slice(index, end);
      index = end;
      continue;
    }
    if (value[index] === '√') {
      const root = parseRootArgument(value, index + 1);
      if (root) {
        output += `\\sqrt{${convertMathContent(root.content)}}`;
        index = root.end;
      } else {
        output += '\\sqrt{}';
        index += 1;
      }
      continue;
    }
    if (Object.hasOwn(superscriptDigits, value[index] ?? '')) {
      let digits = '';
      while (index < value.length && Object.hasOwn(superscriptDigits, value[index] ?? '')) {
        digits += superscriptDigits[value[index] ?? ''];
        index += 1;
      }
      output += `^{${digits}}`;
      continue;
    }
    const replacement = latexSymbols[value[index] ?? ''];
    if (replacement !== undefined) {
      output += replacement;
      if (/^\\[A-Za-z]+$/.test(replacement) && /[A-Za-z]/.test(value[index + 1] ?? '')) output += ' ';
      index += 1;
      continue;
    }
    output += value[index];
    index += 1;
  }
  return output;
}

function normalizeOutsideMath(value: string): string {
  let output = '';
  for (let index = 0; index < value.length;) {
    const quote = quoteAt(value, index);
    if (quote) {
      const quoteEnd = findQuoteEnd(value, index, quote);
      output += value.slice(index, quoteEnd);
      index = quoteEnd;
      continue;
    }
    if (value[index] === '\\') {
      const commandEnd = controlSequenceEnd(value, index);
      const textEnd = skipTextCommand(value, index, commandEnd);
      const end = textEnd ?? commandEnd;
      output += value.slice(index, end);
      index = end;
      continue;
    }
    const char = value[index] ?? '';
    if (asciiMathStart.test(char) || char === '√' || char === 'π' || char === 'θ') {
      const expression = parseExpression(value, index);
      if (expression.hasMathSignal && expression.end > index) {
        output += `\\ensuremath{${convertMathContent(value.slice(index, expression.end))}}`;
        index = expression.end;
        continue;
      }
    }
    const symbol = latexSymbols[char];
    if (symbol !== undefined) {
      output += `\\ensuremath{${symbol}}`;
      index += 1;
      continue;
    }
    output += char;
    index += 1;
  }
  return output;
}

function findDelimiter(value: string, delimiter: string, start: number): number {
  for (let index = start; index <= value.length - delimiter.length; index += 1) {
    if (value.startsWith(delimiter, index) && !isEscaped(value, index)) return index;
  }
  return -1;
}

export function normalizePaperMath(value: string): string {
  let output = '';
  let outside = '';
  const flushOutside = () => {
    output += normalizeOutsideMath(outside);
    outside = '';
  };

  for (let index = 0; index < value.length;) {
    const quote = quoteAt(value, index);
    if (quote) {
      flushOutside();
      const quoteEnd = findQuoteEnd(value, index, quote);
      output += value.slice(index, quoteEnd);
      index = quoteEnd;
      continue;
    }
    if (value[index] === '\\' && !isEscaped(value, index)) {
      const delimiter = value[index + 1] === '(' ? '\\)' : value[index + 1] === '[' ? '\\]' : null;
      if (delimiter) {
        const close = findDelimiter(value, delimiter, index + 2);
        if (close >= 0) {
          flushOutside();
          const open = value.slice(index, index + 2);
          output += `${open}${convertMathContent(value.slice(index + 2, close))}${delimiter}`;
          index = close + delimiter.length;
          continue;
        }
      }
      outside += value[index];
      index += 1;
      continue;
    }
    if (value[index] === '$' && !isEscaped(value, index)) {
      const delimiter = value[index + 1] === '$' ? '$$' : '$';
      const close = findDelimiter(value, delimiter, index + delimiter.length);
      if (close >= 0) {
        flushOutside();
        output += `${delimiter}${convertMathContent(value.slice(index + delimiter.length, close))}${delimiter}`;
        index = close + delimiter.length;
        continue;
      }
    }
    outside += value[index];
    index += 1;
  }
  flushOutside();
  return output;
}
