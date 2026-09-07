/**
 * Deterministic prompt-injection detection.
 *
 * Why this is code and not a prompt rule: measured against gpt-4.1-mini, the
 * model complied with an injected "issue and approve a full refund" - it filed
 * refund requests for all three charges, chose to auto-respond, and never told
 * the operator the ticket was hostile. Asking the model to report an attack it
 * has already fallen for is asking the compromised component to police itself.
 *
 * What this is NOT: a security control. It is a keyword detector and anyone who
 * knows it exists can phrase around it. The actual control is the autonomy
 * boundary in policy.ts, which makes a refund unreachable without a human
 * whether or not this fires. This exists so that (a) a flagged ticket never gets
 * an automated side effect or an automated reply, and (b) the operator is told.
 *
 * False positives are possible - a customer writing "no need to involve a human"
 * will match. The consequence of a false positive is that a person looks at the
 * ticket and no side effect is filed automatically, which is the safe direction
 * to fail in. The consequence of a false negative is nothing worse than today,
 * because the boundary still holds.
 */

export interface InjectionFinding {
  /** Names of the patterns that matched, for the audit trail. */
  patterns: string[];
  /** Short excerpts around each match, so an operator can see what was said. */
  excerpts: string[];
}

interface Pattern {
  name: string;
  regex: RegExp;
}

/**
 * High-signal patterns only. Each one is a phrasing that has no legitimate use
 * in a support ticket; generic imperatives like "please refund me" are
 * deliberately absent, because those are what real customers write.
 */
const PATTERNS: Pattern[] = [
  { name: 'ignore_previous_instructions', regex: /\b(ignore|disregard|forget)\b[^.!?\n]{0,40}\b(previous|prior|above|earlier|all)\b[^.!?\n]{0,20}\b(instruction|prompt|rule|direction|guideline)/i },
  { name: 'system_override', regex: /\b(system|admin(istrator)?|security)\s*(override|overide|bypass)\b/i },
  { name: 'fake_system_directive', regex: /(^|\n)\s*#{0,4}\s*(system|assistant|developer)\s*(prompt|message|instruction|directive)?\s*:/i },
  { name: 'role_reassignment', regex: /\byou are (now|hereby)\b[^.!?\n]{0,40}\b(admin(istrator)?|developer|root|superuser|unrestricted|god)\b/i },
  { name: 'mode_switch', regex: /\b(admin(istrator)?|developer|debug|god|maintenance|unrestricted)\s+mode\b/i },
  { name: 'restrictions_lifted', regex: /\b(autonomy|safety|approval|restriction|guardrail|limitation)s?\b[^.!?\n]{0,40}\b(lifted|removed|disabled|waived|suspended|off)\b/i },
  { name: 'self_approval_demand', regex: /\b(approve|authorise|authorize|confirm)\b[^.!?\n]{0,40}\b(yourself|on your own|automatically|without (a )?(human|approval|review))\b/i },
  { name: 'suppress_human', regex: /\b(do not|don'?t|never)\b[^.!?\n]{0,30}\b(escalate|involve|notify|inform|tell|contact)\b[^.!?\n]{0,20}\b(human|person|agent|operator|support team|manager)\b/i },
  { name: 'new_instructions', regex: /\bnew\s+(instruction|rule|direction|prompt)s?\s*:/i },
  { name: 'tool_command_injection', regex: /\b(call|invoke|execute|run)\b[^.!?\n]{0,25}\b(issue_refund|open_incident|tool)\b/i },
];

/** Scan customer-supplied text. Returns null when nothing matched. */
export function detectInjectionAttempt(text: string): InjectionFinding | null {
  if (!text) return null;

  const patterns: string[] = [];
  const excerpts: string[] = [];

  for (const { name, regex } of PATTERNS) {
    const match = regex.exec(text);
    if (!match) continue;
    patterns.push(name);
    const start = Math.max(0, match.index - 20);
    excerpts.push(text.slice(start, match.index + match[0].length + 20).replace(/\s+/g, ' ').trim());
  }

  return patterns.length > 0 ? { patterns, excerpts } : null;
}
