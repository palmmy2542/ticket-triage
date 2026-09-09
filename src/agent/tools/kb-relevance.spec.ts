import { KB_DOCS } from '../../fixtures/kb';
import { MIN_RELEVANCE, scoreDoc, searchKb, tokenize } from './search-knowledge-base';

/**
 * Relevance-floor behaviour of `search_knowledge_base`.
 *
 * These cases are written from the CORPUS and the customer's INTENT, never from
 * what `scoreDoc` computes: every expectation names the article the writer of
 * `src/fixtures/kb.ts` would point at, or names the absence of such an article.
 * A test that recomputed the scorer's own arithmetic would pass for any
 * normalisation, including the broken one this file exists to pin down.
 *
 * The floor is a product decision, not a display detail: `result_count > 0` is
 * the whole of the knowledge-base grounding check in runner.ts, so a dropped
 * article costs a customer a two-day queue for a question the KB answers, and an
 * admitted wrong article licenses an auto-response grounded in it.
 */

const ids = (query: string, limit = 5): string[] => searchKb(query, limit).map((r) => r.id);
const doc = (id: string) => KB_DOCS.find((d) => d.id === id)!;

// ---------------------------------------------------------------------------
// Direction 1: the floor must not drop the article the corpus was written to
// answer with.
// ---------------------------------------------------------------------------

describe('relevance floor - queries the knowledge base does answer', () => {
  it('returns the seats article for an invite question, because that article is tagged `invite`', () => {
    // Source of truth: `account-seats` in src/fixtures/kb.ts carries the tag
    // `invite` and its body is the Settings > Members flow. This is the article
    // a support engineer would send. Measured before the fix: 0.167, below a
    // 0.25 floor, so the tool returned NOTHING and the ticket went to a human.
    expect(ids('invite a new user to my team')[0]).toBe('account-seats');
  });

  it('returns the same article when the same intent is worded differently', () => {
    // The pair matters more than either case alone: whether a paying customer
    // gets an instant answer must not turn on which synonym they typed. Before
    // the fix this one worked (0.444) and the `invite` phrasing did not.
    expect(ids('how do I add someone to my workspace')[0]).toBe('account-seats');
  });

  it('does not penalise a document for query words the corpus cannot match at all', () => {
    // `new`, `user` and `team` appear nowhere in any of the seven documents, so
    // they carry no information about which article to return - they are the
    // customer's vocabulary, not the corpus's. Scoring them as misses is what
    // made the two phrasings above disagree, so the padding must not move the
    // score by even a rounding step.
    const bare = scoreDoc(doc('account-seats'), tokenize('invite'));
    const padded = scoreDoc(doc('account-seats'), tokenize('invite a new user to my team'));
    expect(padded).toBe(bare);
  });

  it('keeps every eval case that is meant to be answered from the knowledge base', () => {
    // eval/tickets.labelled.json expects auto_respond for t3/t4/t6, which the
    // grounding guard only permits with a KB hit behind it. If any of these
    // three stops returning its article, those cases silently degrade to
    // route_to_specialist and a human answers a documented question.
    expect(ids('dark mode settings appearance system default')[0]).toBe('appearance-dark-mode');
    expect(ids('export document as PDF only CSV available')[0]).toBe('exports-pro');
    expect(ids('HTTP 429 rate limit nightly sync API')[0]).toBe('api-rate-limits');
  });
});

// ---------------------------------------------------------------------------
// Direction 2: the floor must not admit an article that does not answer the
// question. `result_count: 1` is what licenses an auto-response.
// ---------------------------------------------------------------------------

describe('relevance floor - queries the knowledge base does not answer', () => {
  it('returns nothing for a data-deletion request, because no article covers deletion', () => {
    // Source of truth: no document in src/fixtures/kb.ts mentions deletion,
    // personal data or GDPR - `account-seats` is about seat counts and billing
    // pro rata. Before the fix it came back at exactly 0.25, cleared the floor,
    // and licensed an auto-response to a GDPR request off a seats article.
    expect(ids('delete my account and data gdpr')).toEqual([]);
  });

  it('scores a shared, generic word below a word unique to one article', () => {
    // `account` occurs in four of the seven documents, `invite` in exactly one.
    // The generic match is even wider inside the document (tags AND body, vs a
    // tag alone), so raw overlap ranks it HIGHER - which is how a seats article
    // answered a GDPR request. A word that four articles share cannot identify
    // one of them, and the score has to say so.
    const seats = doc('account-seats');
    const generic = scoreDoc(seats, tokenize('delete my account and data gdpr'));
    const specific = scoreDoc(seats, tokenize('invite a new user to my team'));
    expect(generic).toBeLessThan(specific);
    // And the floor has to sit between them, or the pair proves nothing.
    expect(generic).toBeLessThan(MIN_RELEVANCE);
    expect(specific).toBeGreaterThanOrEqual(MIN_RELEVANCE);
  });

  it('returns nothing for a blocked-login ticket that only brushes an article in passing', () => {
    // The exact regression named in the MIN_RELEVANCE history: a live run
    // answered a blocked-login ticket from a single incidental body match
    // ("cannot" appears once in the upgrade article's prose). One passing word
    // in one body is not grounding for a customer-facing reply.
    expect(ids('cannot log in spinner forever')).toEqual([]);
    expect(ids('login stuck spinner cannot sign in')).toEqual([]);
  });

  it('returns nothing when a long ticket is pasted in whole and only grazes an article', () => {
    // Verbatim eval case t7, which expects escalate_to_human/route_to_specialist
    // and forbids open_incident: one paying user is blocked while their region
    // is healthy. `workspace` and `same` appear in the ticket as ordinary
    // English, not as a question about seats, and a long ticket must not be able
    // to accumulate its way over the floor on words like those.
    const t7 =
      "I can't log in at all since this morning - it just spins forever. " +
      'My colleague on the same workspace is fine, so it seems to be just me.';
    expect(ids(t7)).toEqual([]);
  });

  it('returns nothing for the ambiguous one-liner and the data-exposure report', () => {
    // eval t9 ("it doesn't work") and t8 (documents from another company are
    // visible). Both must reach a human; t9 in particular matches the API
    // article only through the word "work".
    expect(ids("it doesn't work")).toEqual([]);
    expect(ids('documents belonging to another company visible reports page')).toEqual([]);
  });

  it('returns nothing for a Thai duplicate-charge refund demand', () => {
    // eval t10. The tokenizer leaves only "pro" and "refund" behind (see the
    // Thai limitation below), and "Pro" is in the export article's title, tags
    // and body. An export article must not be the grounding behind a reply to a
    // customer asking for their money back.
    expect(
      ids('ถูกตัดเงินซ้ำ 3 ครั้ง ครั้งละ $29.99 แต่ยังใช้ Pro ไม่ได้เลยครับ ขอ refund ด้วย'),
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Known limitation, tracked separately: the tokenizer, not the floor.
// ---------------------------------------------------------------------------

describe('relevance floor - Thai queries (characterisation, not desired behaviour)', () => {
  it('finds nothing at all when a Thai query has no ASCII anchor', () => {
    // `tokenize` splits on anything outside \p{L}/\p{N}, and Thai vowel and tone
    // marks are neither, so a Thai run shatters into fragments that match
    // nothing. Retrieval for such a ticket is decided entirely by whatever
    // English happens to be embedded in it. Out of scope here: the fix is a
    // tokenizer/synonym change, not a threshold change.
    expect(ids('ระบบเข้าไม่ได้ครับ')).toEqual([]);
  });

  it('CAPTURES a false positive: a Thai query whose only English word is generic', () => {
    // Not desired behaviour - recorded so that changing it is a deliberate act.
    // Because unmatched tokens no longer count against a document, a Thai
    // sentence is now scored on its English anchors alone: here the single word
    // `workspace` (in the seats article's title) decides the whole query and the
    // seats article comes back for "cannot access the workspace". Before the
    // fix, the Thai fragments diluted it to 0.222 and nothing was returned.
    // Fixing this belongs to the tokenizer finding; if that lands, delete this.
    expect(ids('เข้าใช้งาน workspace ไม่ได้')).toEqual(['account-seats']);
  });
});
