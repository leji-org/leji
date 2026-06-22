// Single source of truth for supported runtimes; add one here and the chips and install tabs both update.
import nodeIcon from '../assets/node.svg?raw';
import pythonIcon from '../assets/python.svg?raw';
import goIcon from '../assets/go.svg?raw';

export interface Runtime {
   /** Short runtime name, e.g. "Node". */
   name: string;
   /** Display label with its minimum version, e.g. "Node.js 22+". */
   label: string;
   /** Inline SVG markup for the runtime's icon. */
   icon: string;
   /** The bare install command (no comments), for copy-to-clipboard. */
   command: string;
   /** Wide logos render shorter to balance with square marks. */
   wide?: boolean;
}

export const runtimes: Runtime[] = [
   {
      name: 'Node',
      label: 'Node.js 22+',
      icon: nodeIcon,
      command: 'npm install -g @leji-org/leji',
   },
   {
      name: 'Python',
      label: 'Python 3.10+',
      icon: pythonIcon,
      command: 'pip install leji',
   },
   {
      name: 'Go',
      label: 'Go 1.23+',
      icon: goIcon,
      command: 'go install github.com/leji-org/leji/packages/sdk-go/cmd/leji@latest',
      wide: true,
   },
];
