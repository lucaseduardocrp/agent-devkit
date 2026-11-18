/** What a module is asked to open when another module sends the user to one of its items. */
export type FocusKind = 'pbi' | 'issue' | 'brain' | 'spec' | 'testplan';

export interface ReferenceFocus {
  readonly kind: FocusKind;
  /** Id of the item in its module (the page id for Brain). */
  readonly ref: string;
  /** The passage to show highlighted once the item is open (Brain pages). */
  readonly excerpt?: string;
  /** Changes with every request, so asking for the same item twice opens it twice. */
  readonly nonce: number;
}
