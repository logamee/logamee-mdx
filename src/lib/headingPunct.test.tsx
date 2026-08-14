import React from 'react';
import { describe, expect, it } from 'vitest';
import { JINXIU_HEADING_PUNCT_CLASS, mapH2ChildrenWrapHeadingSymbols, wrapPlainTextWithJinxiuHeadingPunct } from './headingPunct';

describe('Jinxiu heading punctuation', () => {
  it('wraps supported heading symbols in marker spans', () => {
    const nodes = wrapPlainTextWithJinxiuHeadingPunct('Intro ■ Detail ▪ Tail', 'heading');

    expect(nodes).toHaveLength(5);
    expect(nodes[0]).toBe('Intro ');
    expect(React.isValidElement(nodes[1])).toBe(true);
    expect((nodes[1] as React.ReactElement<{ className: string; children: string }>).props.className).toBe(JINXIU_HEADING_PUNCT_CLASS);
    expect((nodes[1] as React.ReactElement<{ children: string }>).props.children).toBe('■');
    expect((nodes[3] as React.ReactElement<{ children: string }>).props.children).toBe('▪');
  });

  it('returns unchanged text when no supported heading symbol exists', () => {
    expect(wrapPlainTextWithJinxiuHeadingPunct('Plain heading', 'heading')).toEqual(['Plain heading']);
  });

  it('preserves non-text h2 children while wrapping text fragments', () => {
    const strong = <strong key="strong">Important</strong>;
    const mapped = mapH2ChildrenWrapHeadingSymbols(['A ■ ', strong, ' ▪ B']) as React.ReactNode[];

    expect(mapped.some((node) => node === strong)).toBe(true);
    expect(
      mapped.filter(
        (node): node is React.ReactElement<{ className?: string }> =>
          React.isValidElement<{ className?: string }>(node) && node.props.className === JINXIU_HEADING_PUNCT_CLASS,
      ),
    ).toHaveLength(2);
  });
});
