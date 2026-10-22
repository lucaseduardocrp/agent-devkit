import { Textarea, type TextareaProps } from '../../components/ui/textarea.js';
import type { AttachmentScope } from './attachment-types.js';
import { ImageInputStatus, useMarkdownImageInput } from './media.js';

interface Props extends Omit<TextareaProps, 'value' | 'onChange'> {
  readonly scope: AttachmentScope;
  readonly value: string;
  readonly onValueChange: (value: string) => void;
  /** Hides the paste/drop hint; upload progress and errors still show. */
  readonly quiet?: boolean;
}

/** Markdown textarea where pasted or dropped images are uploaded and written in place. */
export function MarkdownImageTextarea({
  scope,
  value,
  onValueChange,
  quiet = false,
  ...props
}: Props) {
  const images = useMarkdownImageInput(scope, onValueChange);
  return (
    <>
      <Textarea
        {...props}
        value={value}
        onChange={(event) => onValueChange(event.target.value)}
        onPaste={images.onPaste}
        onDrop={images.onDrop}
      />
      {(!quiet || images.error) && <ImageInputStatus state={images} />}
    </>
  );
}
