import type { SatteriMarkdownProcessorOptions, SatteriProcessorOptions } from '@astrojs/markdown-satteri';
import { satteriMdLinks } from './satteri-md-links';
import { satteriTableScroll } from './satteri-table-scroll';
import { satteriHeadingAnchors } from './satteri-heading-anchors';
import { satteriCjkGap } from './satteri-cjk-gap';
import lejiSyntaxTheme from './styles/shiki-leji.json';

export const markdownProcessorOptions = {
   // The gap plugin runs last: it reads the edges of the tree the others have left.
   hastPlugins: [satteriMdLinks, satteriTableScroll, satteriHeadingAnchors, satteriCjkGap],
   features: {
      gfm: true,
      smartPunctuation: true,
   },
} satisfies SatteriProcessorOptions;

export const markdownRenderOptions = {
   ...markdownProcessorOptions,
   shikiConfig: { theme: lejiSyntaxTheme },
} satisfies SatteriMarkdownProcessorOptions;
