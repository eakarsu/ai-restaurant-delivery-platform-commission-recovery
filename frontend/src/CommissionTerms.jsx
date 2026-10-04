import React, { useEffect, useState } from 'react';

const money = cents => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(Number(cents || 0) / 100);
export default function CommissionTerms({ request, notify, user, onSaved }) {
  const [cases, setCases] = useState([]);
  const [sources, setSources] = useState([]);
  const [terms, setTerms] = useState([]);
  const [selectedSource, setSelectedSource] = useState(null);
  const [selectedTerm, setSelectedTerm] = useState(null);
  const [assessments, setAssessments] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [rationale, setRationale] = useState('');
  const [sourceForm, setSourceForm] = useState({ title: '', content: '' });
  const [form, setForm] = useState({ restaurant: '', effectiveOn: '2026-01-01', expiresOn: '2026-12-31',
    percent: '', sourceId: '', sourceQuote: '', clauseLocator: '' });
  async function load() {
    const [caseData, sourceData, termData] = await Promise.all([
      request('/api/delivery/cases'), request('/api/delivery/sources'), request('/api/delivery/terms'),
    ]);
    setCases(caseData.items || []); setSources(sourceData.items || []); setTerms(termData.items || []);
  }
  useEffect(() => { load().catch(err => setError(err.message)); }, []);
  async function act(work) {
    setBusy(true); setError('');
    try { await work(); await load(); await onSaved(); }
    catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }
  async function viewSource(sourceId) {
    setBusy(true); setError('');
    try { setSelectedSource((await request(`/api/delivery/sources/${sourceId}`)).source); }
    catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }
  async function viewTerm(term) {
    setSelectedTerm(term); setError('');
    try { setAssessments((await request(`/api/delivery/terms/${term.id}/assessments`)).items || []); }
    catch (err) { setError(err.message); }
  }
  const restaurants = [...new Set(cases.map(item => item.restaurant).filter(Boolean))];
  const canDraft = ['admin', 'operator'].includes(user.role);
  const canReview = ['admin', 'reviewer'].includes(user.role);
  return <>
    <header className="pageTitle"><div><span className="eyebrow">Restaurant agreement evidence</span><h2>Commission terms</h2><p>Save operator-entered text from a signed fee agreement, cite an exact quote, obtain independent approval, then assess imported commission lines. Source authenticity and platform acceptance are not verified here.</p></div></header>
    {error && <p className="error" role="alert">{error}</p>}
    <section className="panel"><h3>1. Save agreement text</h3><p>Paste text from the restaurant’s platform agreement. The saved content and SHA-256 hash are retained; a reviewer should compare the quote with the original signed agreement.</p>
      <form onSubmit={event => { event.preventDefault(); act(async () => { await request('/api/delivery/sources', { method: 'POST', body: JSON.stringify(sourceForm) }); setSourceForm({ title: '', content: '' }); notify('Agreement text saved.'); }); }}>
        <label>Agreement title<input required minLength={3} maxLength={200} value={sourceForm.title} onChange={event => setSourceForm({ ...sourceForm, title: event.target.value })}/></label>
        <label>Operator-entered agreement text<textarea required minLength={30} maxLength={500000} rows={7} value={sourceForm.content} onChange={event => setSourceForm({ ...sourceForm, content: event.target.value })}/></label>
        <button className="primary" disabled={busy || !canDraft}>Save agreement text</button>
      </form>
      {sources.length > 0 && <div className="tableWrap"><table><thead><tr><th>Source</th><th>SHA-256</th></tr></thead><tbody>{sources.map(source => <tr key={source.id}><td><button className="secondary" onClick={() => viewSource(source.id)}>{source.title}</button></td><td><code>{source.content_hash.slice(0, 20)}…</code></td></tr>)}</tbody></table></div>}
      {selectedSource && <details open><summary>{selectedSource.title} · saved text</summary><pre style={{ whiteSpace: 'pre-wrap' }}>{selectedSource.content}</pre></details>}
    </section>
    <section className="panel"><h3>2. Draft a restaurant commission term</h3><p>Select a real Commission-rate validation case. The quote must appear exactly in saved text and state the commission rate on the order subtotal plus both effective dates in YYYY-MM-DD form. The calculation applies this rate to each imported order subtotal, excluding tax, tips, delivery fees and promotions from the base only if the entered subtotal does so.</p>
      {restaurants.length === 0 && <p>Create a real Commission-rate validation case first. Example cases cannot support a claim.</p>}
      <form onSubmit={event => { event.preventDefault(); act(async () => { const data = await request('/api/delivery/terms', { method: 'POST', body: JSON.stringify(form) }); notify(`Commission term version ${data.term.version} drafted for independent review.`); }); }}>
        <div className="formGrid">
          <label>Platform / restaurant<select required value={form.restaurant} onChange={event => setForm({ ...form, restaurant: event.target.value })}><option value="">Select restaurant</option>{restaurants.map(name => <option key={name}>{name}</option>)}</select></label>
          <label>Commission percentage<input required type="number" min="0" max="100" step="0.0001" value={form.percent} onChange={event => setForm({ ...form, percent: event.target.value })}/></label>
          <label>Effective date<input required type="date" value={form.effectiveOn} onChange={event => setForm({ ...form, effectiveOn: event.target.value })}/></label>
          <label>Expiry date<input required type="date" value={form.expiresOn} onChange={event => setForm({ ...form, expiresOn: event.target.value })}/></label>
          <label>Saved agreement source<select required value={form.sourceId} onChange={event => setForm({ ...form, sourceId: event.target.value })}><option value="">Select source</option>{sources.map(source => <option key={source.id} value={source.id}>{source.title}</option>)}</select></label>
          <label>Page or section<input required minLength={2} maxLength={200} value={form.clauseLocator} onChange={event => setForm({ ...form, clauseLocator: event.target.value })}/></label>
        </div>
        <label>Exact agreement quote<textarea required minLength={12} maxLength={5000} rows={3} placeholder="Commission is 15% of the order subtotal…" value={form.sourceQuote} onChange={event => setForm({ ...form, sourceQuote: event.target.value })}/></label>
        <button className="primary" disabled={busy || !canDraft || restaurants.length === 0}>Draft term</button>
      </form>
    </section>
    <section className="panel"><h3>3. Review and assess</h3><p>A different admin or reviewer must approve each draft. Approval supersedes the prior version for this restaurant. Assess imported rows with fee_type <code>commission</code>, a unique order_id, date, amount and order_subtotal.</p>
      {terms.length ? <div className="tableWrap"><table><thead><tr><th>Restaurant</th><th>Version</th><th>Rate</th><th>Window</th><th>Status</th><th>Action</th></tr></thead><tbody>{terms.map(term => <tr key={term.id}><td><button className="secondary" onClick={() => viewTerm(term)}>{term.restaurant_label}</button></td><td>{term.version}</td><td>{Number(term.percent_units) / 10000}%</td><td>{String(term.effective_on).slice(0, 10)} – {String(term.expires_on).slice(0, 10)}</td><td>{term.status}</td><td>{term.status === 'APPROVED' && <button className="secondary" disabled={busy} onClick={() => act(async () => { const result = await request(`/api/delivery/terms/${term.id}/assess`, { method: 'POST', body: '{}' }); notify(`${result.newAssessments} imported commission line(s) assessed.`); await viewTerm(term); })}>Assess imports</button>}</td></tr>)}</tbody></table></div> : <p>No commission terms drafted yet.</p>}
      {selectedTerm && <div><h4>{selectedTerm.restaurant_label} · version {selectedTerm.version}</h4><p>Source: {selectedTerm.source_title} · SHA-256 <code>{selectedTerm.source_hash}</code> · {selectedTerm.clause_locator}</p><blockquote>{selectedTerm.source_quote}</blockquote>
        {selectedTerm.status === 'DRAFT' && <form onSubmit={event => { event.preventDefault(); act(async () => { await request(`/api/delivery/terms/${selectedTerm.id}/approve`, { method: 'POST', body: JSON.stringify({ rationale }) }); setRationale(''); setSelectedTerm(null); notify('Commission term independently approved.'); }); }}><label>Independent review rationale<textarea required minLength={20} maxLength={2000} value={rationale} onChange={event => setRationale(event.target.value)}/></label><button className="primary" disabled={busy || !canReview || String(selectedTerm.created_by_id) === String(user.id)}>Approve term</button></form>}
        <h4>Imported line assessments</h4>{assessments.length ? <div className="tableWrap"><table><thead><tr><th>Source line</th><th>Order</th><th>Charged</th><th>Expected</th><th>Variance</th><th>Result</th></tr></thead><tbody>{assessments.map(item => <tr key={item.id}><td>{item.source_file} #{item.line_number}</td><td>{item.calculation?.orderId || '—'}</td><td>{money(item.observed_cents)}</td><td>{item.expected_cents == null ? '—' : money(item.expected_cents)}</td><td>{item.variance_cents == null ? '—' : money(item.variance_cents)}</td><td>{item.status}{item.calculation?.reason ? ` · ${item.calculation.reason}` : ''}</td></tr>)}</tbody></table></div> : <p>No imported commission lines assessed for this version.</p>}
      </div>}
    </section>
  </>;
}
