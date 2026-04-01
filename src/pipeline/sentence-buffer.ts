/**
 * Buffers streaming LLM tokens into sentence-level chunks.
 * This enables TTS to start speaking before the LLM finishes generating,
 * reducing perceived latency by overlapping LLM generation with TTS synthesis.
 */
export class SentenceBuffer {
  private buffer = "";
  private onSentence: (sentence: string) => void;

  // Sentence-ending punctuation that triggers a flush to TTS
  private static SENTENCE_ENDERS = /[.!?]/;
  // Also flush on commas if the buffer is long enough (natural pause points)
  private static CLAUSE_ENDER = /,/;
  private static MIN_CLAUSE_LENGTH = 40;

  constructor(onSentence: (sentence: string) => void) {
    this.onSentence = onSentence;
  }

  /** Add a token/chunk from the LLM stream */
  add(text: string): void {
    this.buffer += text;

    // Check for sentence-ending punctuation
    if (SentenceBuffer.SENTENCE_ENDERS.test(text)) {
      this.flush();
      return;
    }

    // Check for clause-ending comma with sufficient length
    if (
      SentenceBuffer.CLAUSE_ENDER.test(text) &&
      this.buffer.trim().length >= SentenceBuffer.MIN_CLAUSE_LENGTH
    ) {
      this.flush();
      return;
    }
  }

  /** Force flush whatever is in the buffer (called when LLM finishes) */
  flush(): void {
    const text = this.buffer.trim();
    if (text) {
      this.onSentence(text);
      this.buffer = "";
    }
  }

  /** Clear the buffer without sending (for interruptions) */
  clear(): void {
    this.buffer = "";
  }

  /** Check if the buffer has any pending content */
  hasPending(): boolean {
    return this.buffer.trim().length > 0;
  }
}
