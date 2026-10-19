import { describe, expect, it } from 'vitest';
import { collectAndNormalizeProvider, customerLossProvider } from '../../src/core/intent/providers/index.js';
import { findComplaints } from '../../src/core/intent/providers/customerLoss.js';

const base = { company_domain: 'smile.example', company_name: 'Smile Dental' };

describe('customer-loss provider', () => {
  it('turns unreachable-customer reviews into a FACT signal and flags a site with no booking or chat', async () => {
    const result = await collectAndNormalizeProvider(customerLossProvider, [{
      ...base,
      reviews: [
        { text: 'Lovely dentist but nobody answers the phone, I gave up.', rating: 2 },
        { text: 'Rang three times, went to voicemail, never called back.', rating: 1 },
        { text: 'Great hygienist, quick appointment.', rating: 5 },
        { text: 'Ninguém atende o telefone.', rating: 1 },
      ],
      website_html: '<html><body><h1>Smile Dental</h1><p>Call us on 0117 000 0000</p></body></html>',
    }]);

    expect(result.status).toBe('IMPLEMENTED');
    const reviews = result.signals.find(s => s.source === 'PUBLIC_REVIEWS');
    expect(reviews).toMatchObject({ signalType: 'CUSTOMER_LOSS', evidenceClassification: 'FACT', intentWeight: 84 });
    expect((reviews!.normalizedData as { complaint_count: number }).complaint_count).toBe(3);
    expect(result.signals.find(s => s.source === 'PUBLIC_WEBSITE')).toMatchObject({ evidenceClassification: 'INFERENCE' });
  });

  it('stays silent when the site already books online and reviews are clean', async () => {
    const result = await collectAndNormalizeProvider(customerLossProvider, [{
      ...base,
      reviews: [{ text: 'Booked online in a minute.', rating: 5 }],
      website_html: '<html><body><a href="https://smile.dentally.co/book">Book online</a></body></html>',
    }]);
    expect(result.signals).toHaveLength(0);
  });

  it('catches real UK vet complaints found by the 17/10 Leeds scan and ignores price/clinical ones', () => {
    const hits = findComplaints([
      { text: 'They told me they were too busy and they will call me back, but I never received anything.', rating: 1 },
      { text: "Tried to call afterwards. They put the phone down on me and haven't heard back since.", rating: 1 },
      { text: 'It took nearly 9 days to get to talk to a vet.', rating: 1 },
      { text: 'The consultation fee alone is £66 before any meds.', rating: 2 },
      { text: 'Sadly there was no response to treatment and we lost him.', rating: 2 },
      { text: 'Easy to get an appointment, either by booking online or via phone.', rating: 5 },
      { text: 'They told me they were too busy and they will call me back, but I never received anything.', rating: 1 },
      { text: "Tried to call afterwards. They put the phone down on me and haven't heard back since. I am still waiting for an answer from anyone…", rating: 0 },
      { text: "Tried to call afterwards. They put the phone down on me and haven't heard back since. I am still waiting for an answer from anyone at all.", rating: 0 },
    ]);
    expect(hits).toHaveLength(4);
  });

  it('trusts a Google Maps booking link over a bare website', async () => {
    const result = await collectAndNormalizeProvider(customerLossProvider, [{
      ...base,
      booking_links: ['https://booksy.com/en-gb/123_smile'],
      website_html: '<html><body><p>Call us</p></body></html>',
    }]);
    expect(result.signals).toHaveLength(0);
  });
});
