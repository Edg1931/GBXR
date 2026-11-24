export type ScamRisk = "low" | "medium" | "high";

const RED_FLAGS: Array<[RegExp, string]> = [
  [/gift\s*cards?/i, "asks for gift cards"],
  [/wire\s*transfer|western union|moneygram|zelle/i, "asks for a wire or instant transfer"],
  [/bitcoin|crypto|btc\b/i, "asks for cryptocurrency"],
  [/act now|immediately|within 24 hours|final notice|urgent/i, "pressures you to act fast"],
  [/suspend|frozen|locked|arrest|warrant|lawsuit/i, "threatens consequences"],
  [/social security number|ssn|medicare number|bank account number|pin\b/i, "asks for personal numbers"],
  [/you('ve| have)? won|prize|lottery|sweepstakes|inheritance/i, "promises a prize or windfall"],
  [/do not tell|keep this confidential|don't tell/i, "asks you to keep it secret"],
];

export function heuristicFlags(text: string): string[] {
  return RED_FLAGS.filter(([re]) => re.test(text)).map(([, label]) => label);
}

/** Combine the model's verdict with local rules; never downgrade the model. */
export function combineRisk(modelRisk: ScamRisk, flags: string[]): ScamRisk {
  const order: ScamRisk[] = ["low", "medium", "high"];
  const fromFlags: ScamRisk = flags.length >= 2 ? "high" : flags.length === 1 ? "medium" : "low";
  return order[Math.max(order.indexOf(modelRisk), order.indexOf(fromFlags))]!;
}
