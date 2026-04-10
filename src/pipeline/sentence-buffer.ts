/**
 * Buffers streaming LLM tokens into speakable chunks for TTS.
 *
 * Aggressively flushes at natural speech boundaries to minimize
 * time-to-first-audio. Priority order:
 * 1. Sentence enders: . ! ?
 * 2. Clause separators: , ; : —
 * 3. Subordinate clause starters: "that", "which", "because", "so", "and", "but"
 * 4. Length-based fallback: flush at 80 chars regardless
 */
export class SentenceBuffer {
  private buffer = "";
  private onSentence: (sentence: string) => void;

  private static SENTENCE_ENDERS = /[.!?]$/;
  private static CLAUSE_SEPARATORS = /[,;:\u2014-]$/; // comma, semicolon, colon, em-dash, hyphen
  private static MIN_CLAUSE_LENGTH = 20; // flush on clause separator if buffer >= this
  private static MAX_BUFFER_LENGTH = 80; // force flush regardless
  // Words that start a new clause — flush BEFORE them if buffer is long enough
  private static CLAUSE_STARTERS = /\s(that|which|because|since|so|and|but|or|if|when|where|while|although|however|also)\s/i;
  private static MIN_CLAUSE_STARTER_LENGTH = 25;

  constructor(onSentence: (sentence: string) => void) {
    this.onSentence = onSentence;
  }

  add(text: string): void {
    this.buffer += text;

    // 1. Sentence-ending punctuation — always flush
    if (SentenceBuffer.SENTENCE_ENDERS.test(this.buffer.trim())) {
      this.flush();
      return;
    }

    // 2. Clause separator with enough content
    if (
      this.buffer.trim().length >= SentenceBuffer.MIN_CLAUSE_LENGTH &&
      SentenceBuffer.CLAUSE_SEPARATORS.test(this.buffer.trim())
    ) {
      this.flush();
      return;
    }

    // 3. Clause-starting conjunction mid-buffer — split before it
    if (this.buffer.trim().length >= SentenceBuffer.MIN_CLAUSE_STARTER_LENGTH) {
      const match = SentenceBuffer.CLAUSE_STARTERS.exec(this.buffer);
      if (match && match.index >= SentenceBuffer.MIN_CLAUSE_LENGTH) {
        // Flush everything before the conjunction
        const before = this.buffer.substring(0, match.index + 1); // include the space
        const after = this.buffer.substring(match.index + 1);
        this.buffer = "";
        const trimmed = before.trim();
        if (trimmed) this.onSentence(trimmed);
        this.buffer = after;
        return;
      }
    }

    // 4. Length-based fallback — force flush on long buffers
    if (this.buffer.trim().length >= SentenceBuffer.MAX_BUFFER_LENGTH) {
      this.flush();
      return;
    }
  }

  flush(): void {
    const text = this.buffer.trim();
    if (text) {
      this.onSentence(text);
      this.buffer = "";
    }
  }

  clear(): void {
    this.buffer = "";
  }

  hasPending(): boolean {
    return this.buffer.trim().length > 0;
  }
}
