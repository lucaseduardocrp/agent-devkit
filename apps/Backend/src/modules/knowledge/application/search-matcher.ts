export interface SearchQueryAnalysis {
  readonly rawPrompt: string;
  readonly cleanedPrompt: string;
  readonly phrases: readonly string[];
  readonly tokens: readonly string[];
}

const STOP_WORDS = new Set([
  'de',
  'do',
  'da',
  'dos',
  'das',
  'em',
  'no',
  'na',
  'nos',
  'nas',
  'um',
  'uma',
  'uns',
  'umas',
  'para',
  'com',
  'por',
  'que',
  'se',
  'os',
  'as',
  'sobre',
  'esse',
  'essa',
  'este',
  'esta',
  'estao',
  'estão',
  'todos',
  'todas',
  'qual',
  'quais',
  'como',
  'onde',
  'quando',
  'the',
  'a',
  'an',
  'in',
  'on',
  'at',
  'to',
  'for',
  'of',
  'and',
  'or',
  'is',
  'it',
]);

export function normalizeDiacritics(text: string): string {
  return text.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

export function analyzeSearchPrompt(prompt: string): SearchQueryAnalysis {
  const normalized = prompt.trim();
  if (!normalized) {
    return { rawPrompt: '', cleanedPrompt: '', phrases: [], tokens: [] };
  }

  const lines = normalized
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const cleaned = normalized
    .replace(
      /\b(escreva|escrever|gerar|gere|crie|criar|descreva|descrever|monte|montar)\s+(todos\s+os\s+|todas\s+as\s+)?(casos\s+de\s+teste|cenários\s+de\s+teste|cenarios\s+de\s+teste|testes|test\s+cases)?(\s+(sobre|para|de|da|do|referente\s+a|relativo\s+a))?(\s+(a\s+feature|a\s+funcionalidade|o\s+recurso|o\s+módulo|o\s+modulo|o\s+fluxo|o\s+requisito|essa\s+feature|esta\s+feature|este\s+recurso|esse\s+recurso))?(\s+(de|da|do))?/gi,
      ' ',
    )
    .replace(/\b(sobre\s+(essa|esta|este)\s+(feature|funcionalidade|requisito))\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const phrases: string[] = [];
  const effectiveCleaned = cleaned || normalized;
  if (effectiveCleaned && effectiveCleaned.length >= 3) {
    phrases.push(effectiveCleaned);
    const unaccented = normalizeDiacritics(effectiveCleaned);
    if (unaccented !== effectiveCleaned && !phrases.includes(unaccented)) {
      phrases.push(unaccented);
    }
  }

  for (const line of lines) {
    const cleanedLine = line
      .replace(
        /\b(escreva|escrever|gerar|gere|crie|criar|descreva|descrever|monte|montar)\s+(todos\s+os\s+|todas\s+as\s+)?(casos\s+de\s+teste|cenários\s+de\s+teste|cenarios\s+de\s+teste|testes|test\s+cases)?(\s+(sobre|para|de|da|do|referente\s+a|relativo\s+a))?(\s+(a\s+feature|a\s+funcionalidade|o\s+recurso|o\s+módulo|o\s+modulo|o\s+fluxo|o\s+requisito|essa\s+feature|esta\s+feature|este\s+recurso|esse\s+recurso))?(\s+(de|da|do))?/gi,
        '',
      )
      .replace(/\b(sobre\s+(essa|esta)\s+feature)\b/gi, '')
      .trim();
    if (cleanedLine && cleanedLine.length >= 3 && !phrases.includes(cleanedLine)) {
      phrases.push(cleanedLine);
      const unaccentedLine = normalizeDiacritics(cleanedLine);
      if (unaccentedLine !== cleanedLine && !phrases.includes(unaccentedLine)) {
        phrases.push(unaccentedLine);
      }
    }
  }

  const rawWords = (cleaned || normalized)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !STOP_WORDS.has(w) && !STOP_WORDS.has(normalizeDiacritics(w)));

  const tokenList: string[] = [];
  for (const word of rawWords) {
    if (!tokenList.includes(word)) {
      tokenList.push(word);
    }
    const unaccentedWord = normalizeDiacritics(word);
    if (unaccentedWord !== word && !tokenList.includes(unaccentedWord)) {
      tokenList.push(unaccentedWord);
    }
  }

  return {
    rawPrompt: normalized,
    cleanedPrompt: effectiveCleaned,
    phrases,
    tokens: tokenList,
  };
}

export function scoreKnowledgeChunk(
  chunk: { readonly content: string; readonly source: string; readonly pageId?: string },
  analysis: SearchQueryAnalysis,
): number {
  let score = 0;
  const contentLower = chunk.content.toLowerCase();
  const contentNorm = normalizeDiacritics(contentLower);

  let decodedSource = chunk.source.toLowerCase();
  try {
    decodedSource = decodeURIComponent(chunk.source).toLowerCase();
  } catch {
    // Keep original
  }
  const sourceNorm = normalizeDiacritics(decodedSource);

  for (const phrase of analysis.phrases) {
    const phraseLower = phrase.toLowerCase();
    const phraseNorm = normalizeDiacritics(phraseLower);

    if (
      decodedSource.includes(phraseLower) ||
      chunk.source.toLowerCase().includes(phraseLower) ||
      sourceNorm.includes(phraseNorm)
    ) {
      score += 120;
    }
    if (contentLower.includes(phraseLower) || contentNorm.includes(phraseNorm)) {
      score += 80;
    }
  }

  for (const token of analysis.tokens) {
    const tokenLower = token.toLowerCase();
    const tokenNorm = normalizeDiacritics(tokenLower);

    if (decodedSource.includes(tokenLower) || sourceNorm.includes(tokenNorm)) {
      score += 35;
    }
    if (contentLower.includes(tokenLower) || contentNorm.includes(tokenNorm)) {
      score += 10;
    }
  }

  return score;
}
