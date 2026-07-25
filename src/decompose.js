'use strict';

function trimSegment(prompt, start, end) {
  while (start < end && /\s/.test(prompt[start])) start += 1;
  while (end > start && /\s/.test(prompt[end - 1])) end -= 1;
  if (start === end) return null;
  return { text: prompt.slice(start, end), start, end };
}

function isWord(character) {
  return character !== undefined && /[\p{L}\p{N}_]/u.test(character);
}

function mergeRanges(ranges) {
  const merged = [];
  for (const range of ranges.sort((a, b) => a.start - b.start || a.end - b.end)) {
    const previous = merged[merged.length - 1];
    if (previous && range.start <= previous.end) previous.end = Math.max(previous.end, range.end);
    else merged.push({ ...range });
  }
  return merged;
}

function delimiterRunLength(prompt, start, delimiter) {
  let end = start;
  while (prompt[end] === delimiter) end += 1;
  return end - start;
}

function findClosingDelimiter(prompt, delimiter, start, requiredLength, allowLonger) {
  for (let index = start; index < prompt.length;) {
    if (prompt[index] !== delimiter) {
      index += 1;
      continue;
    }
    const length = delimiterRunLength(prompt, index, delimiter);
    if (length === requiredLength || (allowLonger && length > requiredLength)) return index + length;
    index += length;
  }
  return prompt.length;
}

function isEscaped(prompt, index) {
  let slashes = 0;
  for (let cursor = index - 1; cursor >= 0 && prompt[cursor] === '\\'; cursor -= 1) slashes += 1;
  return slashes % 2 === 1;
}

/** Mark data/code contexts whose bytes must not be interpreted as evidence requests. */
function scanProtectedRanges(prompt) {
  if (typeof prompt !== 'string') throw new TypeError('prompt must be a string');
  const lexicalRanges = [];
  const quotePairs = { '"': '"', '“': '”', "'": "'", '‘': '’' };

  for (let index = 0; index < prompt.length;) {
    const delimiter = prompt[index];
    const delimiterLength = delimiter === '`' || delimiter === '~'
      ? delimiterRunLength(prompt, index, delimiter) : 0;
    const isCodeDelimiter = delimiter === '`' || (delimiter === '~' && delimiterLength >= 3);
    if (isCodeDelimiter) {
      const end = findClosingDelimiter(
        prompt, delimiter, index + delimiterLength, delimiterLength, delimiterLength >= 3,
      );
      lexicalRanges.push({ start: index, end });
      index = end;
      continue;
    }

    const closeQuote = quotePairs[prompt[index]];
    const isSingle = prompt[index] === "'" || prompt[index] === '‘';
    const canOpen = closeQuote
      && (!isSingle || (!isWord(prompt[index - 1]) && !/\s/u.test(prompt[index + 1] || '')));
    if (canOpen) {
      let close = index + 1;
      while ((close = prompt.indexOf(closeQuote, close)) !== -1) {
        if (isEscaped(prompt, close)) {
          close += closeQuote.length;
          continue;
        }
        if (!isSingle || (!/\s/u.test(prompt[close - 1] || '') && !isWord(prompt[close + 1]))) break;
        close += closeQuote.length;
      }
      const end = close === -1 ? prompt.length : close + closeQuote.length;
      lexicalRanges.push({ start: index, end });
      index = end;
      continue;
    }
    index += 1;
  }

  const ranges = mergeRanges(lexicalRanges);
  const stack = [];
  let rangeIndex = 0;
  for (let index = 0; index < prompt.length; index += 1) {
    while (rangeIndex < ranges.length && index >= ranges[rangeIndex].end) rangeIndex += 1;
    if (rangeIndex < ranges.length && index >= ranges[rangeIndex].start) {
      index = ranges[rangeIndex].end - 1;
      continue;
    }

    if (prompt[index] === '(') stack.push({ start: index, hasOperator: false });
    else if (stack.length > 0 && (
      prompt[index] === ';'
      || (prompt[index] === '&' && prompt[index + 1] === '&')
      || (prompt[index] === '|' && prompt[index + 1] === '|')
    )) stack[stack.length - 1].hasOperator = true;
    else if (prompt[index] === ')' && stack.length > 0) {
      const group = stack.pop();
      if (group.hasOperator) {
        ranges.push({ start: group.start, end: index + 1 });
        if (stack.length > 0) stack[stack.length - 1].hasOperator = true;
      }
    }
  }

  return mergeRanges(ranges);
}

function overlapsRange(start, end, ranges) {
  let low = 0;
  let high = ranges.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (ranges[middle].end <= start) low = middle + 1;
    else high = middle;
  }
  return low < ranges.length && ranges[low].start < end;
}

/**
 * Deterministically split explicit boundaries and high-precision "and + new
 * question" boundaries. Other bare conjunctions stay intact: under-splitting is
 * safer than inventing independent obligations.
 */
function decompose(prompt) {
  if (typeof prompt !== 'string') throw new TypeError('prompt must be a string');
  if (!prompt.trim()) return [];

  // Whitespace runs are bounded to keep the scan linear (CodeQL js/polynomial-redos);
  // a boundary buried in 9+ spaces stays unsplit, which under-splits — the safe direction.
  const boundaries = /,?\s{1,8}(?:and\s{1,8})?then\s{1,8}|,\s{0,8}(?:and|but)\s{1,8}|;\s{0,8}|\s{1,8}and\s{1,8}(?=(?:is|are|was|were|what|where|who|show|find|check|did|does|do|has|have|can|will)\b)/giu;
  const protectedRanges = scanProtectedRanges(prompt);
  const clauses = [];
  let cursor = 0;
  let match;

  while ((match = boundaries.exec(prompt)) !== null) {
    if (overlapsRange(match.index, match.index + match[0].length, protectedRanges)) continue;
    const clause = trimSegment(prompt, cursor, match.index);
    if (clause) clauses.push(clause);
    cursor = match.index + match[0].length;
  }

  const tail = trimSegment(prompt, cursor, prompt.length);
  if (tail) clauses.push(tail);
  return clauses;
}

module.exports = { decompose, overlapsRange, scanProtectedRanges };
