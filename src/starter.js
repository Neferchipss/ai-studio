// The 3D asset pipeline: reference → turnaround views → shots per view, and reference → props → isolated props → Tripo/Meshy.
const e = (source, target, targetHandle) => ({ id: `${source}-${target}-${targetHandle}`, source, target, sourceHandle: 'out', targetHandle });

export const STARTER = {
  name: '3D pipeline',
  globals: {
    character: 'a stylized dwarf blacksmith with a leather apron, braided beard and a big forge hammer',
    style: 'clean 3D game asset concept, neutral studio lighting, plain white background',
  },
  nodes: [
    { id: 'ref', type: 'image', position: { x: 0, y: 0 }, data: { label: 'Reference', images: [] } },
    { id: 'views', type: 'list', position: { x: 0, y: 300 }, data: { label: 'Turnaround views', varName: 'view', text: 'front\nside\nback\nthree-quarter' } },
    { id: 'note', type: 'note', position: { x: 0, y: 560 }, data: { text: '1. Drop the character reference above.\n2. Copy each branch prompt (+ ref image) into Higgsfield, paste the result back.\n3. Results flow right: every view × every shot, every prop gets its own branch.' } },
    {
      id: 'turn', type: 'prompt', position: { x: 380, y: 0 },
      data: { label: 'Turnaround', tool: 'Higgsfield', model: '', resultType: 'images', results: {},
        template: '{character}, full body, {view} view, neutral T-pose, {style}. Match the reference design exactly.' },
    },
    { id: 'shots', type: 'list', position: { x: 820, y: -320 }, data: { label: 'Shots', varName: 'shot', text: 'close-up portrait\nhammering at the anvil\nheroic low-angle pose' } },
    {
      id: 'shotp', type: 'prompt', position: { x: 820, y: 0 },
      data: { label: 'Shots per view', tool: 'Higgsfield', model: '', resultType: 'images', results: {},
        template: '{character}, {shot}, camera seeing the {view} of the character, cinematic lighting. Keep the exact design from the attached image.' },
    },
    { id: 'shotboard', type: 'board', position: { x: 1260, y: 0 }, data: { label: 'Shots', stars: {} } },
    {
      id: 'findprops', type: 'prompt', position: { x: 380, y: 1000 },
      data: { label: 'Find props', tool: 'ChatGPT', model: '', resultType: 'text', splitLines: true, varName: 'prop', results: {},
        template: 'Look at the attached character. List every separate prop or accessory they carry (weapons, tools, bags, jewellery). One short noun phrase per line, nothing else.' },
    },
    {
      id: 'isolate', type: 'prompt', position: { x: 820, y: 1000 },
      data: { label: 'Isolate props', tool: 'Higgsfield', model: '', resultType: 'images', results: {},
        template: 'The {prop} from the reference character, isolated single object, centered, three-quarter view, {style}' },
    },
    { id: 'propboard', type: 'board', position: { x: 1260, y: 1000 }, data: { label: 'Props → Tripo / Meshy', stars: {} } },
  ],
  edges: [
    e('views', 'turn', 'branch'), e('ref', 'turn', 'refs'),
    e('turn', 'shotp', 'branch'), e('shots', 'shotp', 'branch'),
    e('shotp', 'shotboard', 'in'),
    e('ref', 'findprops', 'refs'),
    e('findprops', 'isolate', 'branch'), e('ref', 'isolate', 'refs'),
    e('isolate', 'propboard', 'in'),
  ],
};

// What a fresh canvas starts with: one permanent Prompt node.
export const BLANK = () => ({
  name: 'untitled',
  globals: {},
  edges: [],
  nodes: [
    { id: 'root', type: 'promptbox', position: { x: 0, y: 0 }, deletable: false, data: { label: '', target: 'image', text: '' } },
  ],
});
