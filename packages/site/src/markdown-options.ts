import type { SatteriMarkdownProcessorOptions, SatteriProcessorOptions } from '@astrojs/markdown-satteri';
import { satteriMdLinks } from './satteri-md-links';
import { satteriTableScroll } from './satteri-table-scroll';
import { satteriHeadingAnchors } from './satteri-heading-anchors';

export const markdownProcessorOptions = {
   hastPlugins: [satteriMdLinks, satteriTableScroll, satteriHeadingAnchors],
   features: {
      gfm: true,
      smartPunctuation: true,
   },
} satisfies SatteriProcessorOptions;

export const markdownRenderOptions = {
   ...markdownProcessorOptions,
   shikiConfig: { theme: 'night-owl' },
} satisfies SatteriMarkdownProcessorOptions;
