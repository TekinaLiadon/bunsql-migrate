const adjectives = [
  "brave",
  "calm",
  "eager",
  "golden",
  "jolly",
  "keen",
  "lucky",
  "merry",
  "noble",
  "quick",
  "sharp",
  "swift",
  "vivid",
  "warm",
  "bold",
  "crisp",
];

const nouns = [
  "comet",
  "river",
  "stone",
  "falcon",
  "oak",
  "summit",
  "breeze",
  "creek",
  "ember",
  "lantern",
  "meadow",
  "quartz",
  "ridge",
  "tide",
  "valley",
  "willow",
];

export function randomName(): string {
  const adj = adjectives[Math.floor(Math.random() * adjectives.length)]!;
  const noun = nouns[Math.floor(Math.random() * nouns.length)]!;
  return `${adj}_${noun}`;
}
