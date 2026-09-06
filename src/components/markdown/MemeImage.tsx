import type React from 'react';
import { memeImageAlt } from '../../lib/markdownMemeImage';
import AdaptiveMarkdownImage from '../AdaptiveMarkdownImage';
import './markdownMemeImage.css';

export interface MemeImageProps extends Omit<React.ImgHTMLAttributes<HTMLImageElement>, 'title'> {
  currentFilePath: string | null;
  localAssetsEnabled?: boolean;
  workspaceRoot: string | null;
}

/**
 * Compact meme image card. Image loading still goes through the scoped Markdown
 * asset resolver owned by AdaptiveMarkdownImage.
 */
function MemeImage({
  alt,
  className,
  decoding,
  loading,
  ...props
}: MemeImageProps) {
  return (
    <span className="jinxiu-meme-image-wrap" data-jinxiu-meme-image="true">
      <AdaptiveMarkdownImage
        {...props}
        alt={memeImageAlt(alt)}
        className={['jinxiu-meme-image', className].filter(Boolean).join(' ')}
        decoding={decoding ?? 'async'}
        draggable={false}
        loading={loading ?? 'lazy'}
      />
    </span>
  );
}

export { MemeImage };
export default MemeImage;
