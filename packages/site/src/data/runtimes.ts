// Single source of truth for the supported runtimes. The SupportedRuntimes
// component renders the chips from `label`/`icon`; the Quickstart builds its
// install snippet from `install`. Add a runtime here and both update together.
import nodeIcon from '../assets/node.svg?raw';
import pythonIcon from '../assets/python.svg?raw';
import goIcon from '../assets/go.svg?raw';

export interface Runtime {
   /** Display label with its minimum version, e.g. "Node.js 22+". */
   label: string;
   /** Inline SVG markup for the runtime's icon. */
   icon: string;
   /** The install line shown in the Quickstart (kept aligned for the code block). */
   install: string;
   /** Wordmark-style logos (wider than tall) render at a reduced height for optical balance with square marks. */
   wide?: boolean;
}

export const runtimes: Runtime[] = [
   { label: 'Node.js 22+', icon: nodeIcon, install: 'npm install -g @leji-org/leji   # or: npx @leji-org/leji' },
   { label: 'Python 3.10+', icon: pythonIcon, install: 'pip install leji        # the PyPI twin' },
   {
      label: 'Go 1.23+',
      icon: goIcon,
      install: 'go install github.com/leji-org/leji/packages/sdk-go/cmd/leji@latest   # single binary, no runtime',
      wide: true,
   },
];

/** The Quickstart install snippet, one line per runtime. */
export const installSnippet = runtimes.map((r) => r.install).join('\n');
