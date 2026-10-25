// XRechnung 3.0 in the UN/CEFACT CII syntax (EN 16931). Our invoice lines carry gross prices; the e-invoice needs
// net amounts. Per VAT group the net basis is derived from the gross sum, the tax computed from the basis (BR-CO-17),
// and any cent left over goes into the rounding amount (BT-114), so the amount due always equals the PDF total.

export interface XInvoice {
  number: string;
  typeCode: '380' | '381';
  issueDate: string;
  dueDate: string | null;
  precedingNumber: string | null;
  note: string | null;
  seller: { name: string; street: string; postalCode: string; city: string; country: string; vatId: string | null; taxNumber: string | null; registerNumber: string | null; contactName: string; contactPhone: string; contactEmail: string; smallBusiness: boolean };
  buyer: { name: string; street: string; postalCode: string; city: string; country: string; reference: string; address: string; vatId: string | null };
  payment: { kind: 'transfer'; iban: string; bic: string | null; accountName: string } | { kind: 'direct_debit'; mandateReference: string; creditorId: string; debtorIban: string };
  lines: { text: string; quantity: number; grossCents: number; ratePct: number; periodStart: string | null; periodEnd: string | null }[];
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const amt = (cents: number) => (cents / 100).toFixed(2);
const d102 = (iso: string) => iso.replaceAll('-', '');
const qty = (q: number) => (Number.isInteger(q) ? q.toFixed(0) : q.toFixed(4).replace(/0+$/, ''));


/** Category and reason for a rate: 0 % is exempt (Mitgliedsbeiträge, § 19 UStG for small businesses). */
function category(ratePct: number, smallBusiness: boolean) {
  if (smallBusiness) return { code: 'E', rate: 0, reason: 'Kein Ausweis von Umsatzsteuer, da Kleinunternehmer gemäß § 19 UStG' };
  if (ratePct === 0) return { code: 'E', rate: 0, reason: 'Nicht steuerbar oder steuerfrei (z. B. echter Mitgliedsbeitrag)' };
  return { code: 'S', rate: ratePct, reason: null };
}

/** Net basis, tax and per-line nets for one VAT group so that the lines add up to the basis exactly. */
export function vatGroup(lines: { grossCents: number }[], ratePct: number) {
  const gross = lines.reduce((s, l) => s + l.grossCents, 0);
  const basis = Math.round((gross * 100) / (100 + ratePct));
  const tax = Math.round((basis * ratePct) / 100);
  const nets = lines.map((l) => Math.round((l.grossCents * 100) / (100 + ratePct)));
  // The last line absorbs the cent differences of the per-line rounding.
  if (nets.length) nets[nets.length - 1]! += basis - nets.reduce((s, n) => s + n, 0);
  return { gross, basis, tax, nets };
}

/** Missing XRechnung fields, in German, for the refusal message. */
export function missingFields(x: Omit<XInvoice, 'lines' | 'number' | 'typeCode' | 'issueDate' | 'dueDate' | 'precedingNumber' | 'note'>) {
  const out: string[] = [];
  if (!x.seller.street || !x.seller.postalCode || !x.seller.city) out.push('Anschrift des Vereins');
  if (!x.seller.vatId && !x.seller.taxNumber) out.push('USt-IdNr. oder Steuernummer des Vereins');
  // BR-CO-26: the buyer must be able to identify the seller (VAT id or register number).
  if (!x.seller.vatId && !x.seller.registerNumber) out.push('USt-IdNr. oder Vereinsregisternummer des Vereins');
  if (!x.seller.contactName || !x.seller.contactPhone || !x.seller.contactEmail) out.push('Ansprechperson, Telefon und E-Mail für E-Rechnungen (Einstellungen → Verein)');
  if (!x.buyer.reference) out.push('Leitweg-ID oder Käuferreferenz der empfangenden Stelle');
  if (!x.buyer.address) out.push('E-Rechnungsadresse der empfangenden Stelle');
  if (!x.buyer.street || !x.buyer.postalCode || !x.buyer.city) out.push('Anschrift der empfangenden Stelle');
  if (x.payment.kind === 'transfer' && !x.payment.iban) out.push('IBAN des Vereins');
  return out;
}

export function xrechnungCii(x: XInvoice): string {
  const cats = new Map<string, { code: string; rate: number; reason: string | null; idx: number[] }>();
  x.lines.forEach((l, i) => {
    const c = category(l.ratePct, x.seller.smallBusiness);
    const key = `${c.code}:${c.rate}`;
    cats.set(key, { ...c, idx: [...(cats.get(key)?.idx ?? []), i] });
  });
  const netOf: number[] = new Array(x.lines.length).fill(0);
  const groups = [...cats.values()].map((c) => {
    const g = vatGroup(c.idx.map((i) => x.lines[i]!), c.rate);
    c.idx.forEach((i, n) => (netOf[i] = g.nets[n]!));
    return { ...c, ...g };
  });
  const lineTotal = groups.reduce((s, g) => s + g.basis, 0);
  const taxTotal = groups.reduce((s, g) => s + g.tax, 0);
  const grand = lineTotal + taxTotal;
  const payable = groups.reduce((s, g) => s + g.gross, 0);
  const rounding = payable - grand;
  const periods = x.lines.filter((l) => l.periodStart && l.periodEnd);
  const start = periods.map((l) => l.periodStart!).sort()[0];
  const end = periods.map((l) => l.periodEnd!).sort().at(-1);
  const party = (p: { name: string }) => `<ram:Name>${esc(p.name)}</ram:Name>`;
  const address = (p: { street: string; postalCode: string; city: string; country: string }) =>
    `<ram:PostalTradeAddress><ram:PostcodeCode>${esc(p.postalCode)}</ram:PostcodeCode><ram:LineOne>${esc(p.street)}</ram:LineOne><ram:CityName>${esc(p.city)}</ram:CityName><ram:CountryID>${esc(p.country)}</ram:CountryID></ram:PostalTradeAddress>`;

  const lines = x.lines
    .map((l, i) => {
      const c = category(l.ratePct, x.seller.smallBusiness);
      const net = netOf[i]!;
      // Net unit price with four decimals; the line amount is authoritative (BT-131). Prices are never negative
      // (BR-27): a discount line has a negative quantity instead.
      const q = (l.quantity || 1) * (net < 0 ? -1 : 1);
      const price = (Math.abs(net) / 100 / Math.abs(q)).toFixed(4);
      return `<ram:IncludedSupplyChainTradeLineItem>
      <ram:AssociatedDocumentLineDocument><ram:LineID>${i + 1}</ram:LineID></ram:AssociatedDocumentLineDocument>
      <ram:SpecifiedTradeProduct><ram:Name>${esc(l.text.slice(0, 200))}</ram:Name></ram:SpecifiedTradeProduct>
      <ram:SpecifiedLineTradeAgreement><ram:NetPriceProductTradePrice><ram:ChargeAmount>${price}</ram:ChargeAmount></ram:NetPriceProductTradePrice></ram:SpecifiedLineTradeAgreement>
      <ram:SpecifiedLineTradeDelivery><ram:BilledQuantity unitCode="C62">${qty(q)}</ram:BilledQuantity></ram:SpecifiedLineTradeDelivery>
      <ram:SpecifiedLineTradeSettlement>
        <ram:ApplicableTradeTax><ram:TypeCode>VAT</ram:TypeCode><ram:CategoryCode>${c.code}</ram:CategoryCode><ram:RateApplicablePercent>${c.rate.toFixed(2)}</ram:RateApplicablePercent></ram:ApplicableTradeTax>${
          l.periodStart && l.periodEnd ? `\n        <ram:BillingSpecifiedPeriod><ram:StartDateTime><udt:DateTimeString format="102">${d102(l.periodStart)}</udt:DateTimeString></ram:StartDateTime><ram:EndDateTime><udt:DateTimeString format="102">${d102(l.periodEnd)}</udt:DateTimeString></ram:EndDateTime></ram:BillingSpecifiedPeriod>` : ''
        }
        <ram:SpecifiedTradeSettlementLineMonetarySummation><ram:LineTotalAmount>${amt(net)}</ram:LineTotalAmount></ram:SpecifiedTradeSettlementLineMonetarySummation>
      </ram:SpecifiedLineTradeSettlement>
    </ram:IncludedSupplyChainTradeLineItem>`;
    })
    .join('\n    ');

  const sellerTax = [x.seller.vatId && `<ram:SpecifiedTaxRegistration><ram:ID schemeID="VA">${esc(x.seller.vatId)}</ram:ID></ram:SpecifiedTaxRegistration>`, x.seller.taxNumber && `<ram:SpecifiedTaxRegistration><ram:ID schemeID="FC">${esc(x.seller.taxNumber)}</ram:ID></ram:SpecifiedTaxRegistration>`].filter(Boolean).join('');
  const means =
    x.payment.kind === 'transfer'
      ? `<ram:SpecifiedTradeSettlementPaymentMeans><ram:TypeCode>58</ram:TypeCode><ram:PayeePartyCreditorFinancialAccount><ram:IBANID>${esc(x.payment.iban)}</ram:IBANID><ram:AccountName>${esc(x.payment.accountName)}</ram:AccountName></ram:PayeePartyCreditorFinancialAccount>${x.payment.bic ? `<ram:PayeeSpecifiedCreditorFinancialInstitution><ram:BICID>${esc(x.payment.bic)}</ram:BICID></ram:PayeeSpecifiedCreditorFinancialInstitution>` : ''}</ram:SpecifiedTradeSettlementPaymentMeans>`
      : `<ram:SpecifiedTradeSettlementPaymentMeans><ram:TypeCode>59</ram:TypeCode><ram:PayerPartyDebtorFinancialAccount><ram:IBANID>${esc(x.payment.debtorIban)}</ram:IBANID></ram:PayerPartyDebtorFinancialAccount></ram:SpecifiedTradeSettlementPaymentMeans>`;
  const taxes = groups
    .map((g) => `<ram:ApplicableTradeTax><ram:CalculatedAmount>${amt(g.tax)}</ram:CalculatedAmount><ram:TypeCode>VAT</ram:TypeCode>${g.reason ? `<ram:ExemptionReason>${esc(g.reason)}</ram:ExemptionReason>` : ''}<ram:BasisAmount>${amt(g.basis)}</ram:BasisAmount><ram:CategoryCode>${g.code}</ram:CategoryCode><ram:RateApplicablePercent>${g.rate.toFixed(2)}</ram:RateApplicablePercent></ram:ApplicableTradeTax>`)
    .join('\n      ');

  return `<?xml version="1.0" encoding="UTF-8"?>
<rsm:CrossIndustryInvoice xmlns:rsm="urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100" xmlns:ram="urn:un:unece:uncefact:data:standard:ReusableAggregateBusinessInformationEntity:100" xmlns:udt="urn:un:unece:uncefact:data:standard:UnqualifiedDataType:100" xmlns:qdt="urn:un:unece:uncefact:data:standard:QualifiedDataType:100">
  <rsm:ExchangedDocumentContext>
    <ram:BusinessProcessSpecifiedDocumentContextParameter><ram:ID>urn:fdc:peppol.eu:2017:poacc:billing:01:1.0</ram:ID></ram:BusinessProcessSpecifiedDocumentContextParameter>
    <ram:GuidelineSpecifiedDocumentContextParameter><ram:ID>urn:cen.eu:en16931:2017#compliant#urn:xeinkauf.de:kosit:xrechnung_3.0</ram:ID></ram:GuidelineSpecifiedDocumentContextParameter>
  </rsm:ExchangedDocumentContext>
  <rsm:ExchangedDocument>
    <ram:ID>${esc(x.number)}</ram:ID>
    <ram:TypeCode>${x.typeCode}</ram:TypeCode>
    <ram:IssueDateTime><udt:DateTimeString format="102">${d102(x.issueDate)}</udt:DateTimeString></ram:IssueDateTime>${x.note ? `\n    <ram:IncludedNote><ram:Content>${esc(x.note.slice(0, 1000))}</ram:Content></ram:IncludedNote>` : ''}
  </rsm:ExchangedDocument>
  <rsm:SupplyChainTradeTransaction>
    ${lines}
    <ram:ApplicableHeaderTradeAgreement>
      <ram:BuyerReference>${esc(x.buyer.reference)}</ram:BuyerReference>
      <ram:SellerTradeParty>
        ${party(x.seller)}
        ${x.seller.registerNumber ? `<ram:SpecifiedLegalOrganization><ram:ID>${esc(x.seller.registerNumber)}</ram:ID></ram:SpecifiedLegalOrganization>` : ''}
        <ram:DefinedTradeContact><ram:PersonName>${esc(x.seller.contactName)}</ram:PersonName><ram:TelephoneUniversalCommunication><ram:CompleteNumber>${esc(x.seller.contactPhone)}</ram:CompleteNumber></ram:TelephoneUniversalCommunication><ram:EmailURIUniversalCommunication><ram:URIID>${esc(x.seller.contactEmail)}</ram:URIID></ram:EmailURIUniversalCommunication></ram:DefinedTradeContact>
        ${address(x.seller)}
        <ram:URIUniversalCommunication><ram:URIID schemeID="EM">${esc(x.seller.contactEmail)}</ram:URIID></ram:URIUniversalCommunication>
        ${sellerTax}
      </ram:SellerTradeParty>
      <ram:BuyerTradeParty>
        ${party(x.buyer)}
        ${address(x.buyer)}
        <ram:URIUniversalCommunication><ram:URIID schemeID="EM">${esc(x.buyer.address)}</ram:URIID></ram:URIUniversalCommunication>${x.buyer.vatId && !groups.every((g) => g.code === 'E') ? `\n        <ram:SpecifiedTaxRegistration><ram:ID schemeID="VA">${esc(x.buyer.vatId)}</ram:ID></ram:SpecifiedTaxRegistration>` : ''}
      </ram:BuyerTradeParty>
    </ram:ApplicableHeaderTradeAgreement>
    <ram:ApplicableHeaderTradeDelivery>${start ? '' : `<ram:ActualDeliverySupplyChainEvent><ram:OccurrenceDateTime><udt:DateTimeString format="102">${d102(x.issueDate)}</udt:DateTimeString></ram:OccurrenceDateTime></ram:ActualDeliverySupplyChainEvent>`}</ram:ApplicableHeaderTradeDelivery>
    <ram:ApplicableHeaderTradeSettlement>${x.payment.kind === 'direct_debit' ? `\n      <ram:CreditorReferenceID>${esc(x.payment.creditorId)}</ram:CreditorReferenceID>` : ''}
      <ram:PaymentReference>${esc(x.number)}</ram:PaymentReference>
      <ram:InvoiceCurrencyCode>EUR</ram:InvoiceCurrencyCode>
      ${means}
      ${taxes}${start && end ? `\n      <ram:BillingSpecifiedPeriod><ram:StartDateTime><udt:DateTimeString format="102">${d102(start)}</udt:DateTimeString></ram:StartDateTime><ram:EndDateTime><udt:DateTimeString format="102">${d102(end)}</udt:DateTimeString></ram:EndDateTime></ram:BillingSpecifiedPeriod>` : ''}
      <ram:SpecifiedTradePaymentTerms><ram:Description>${x.dueDate ? `Zahlbar bis ${x.dueDate.split('-').reverse().join('.')}` : 'Zahlbar sofort'}</ram:Description>${x.dueDate ? `<ram:DueDateDateTime><udt:DateTimeString format="102">${d102(x.dueDate)}</udt:DateTimeString></ram:DueDateDateTime>` : ''}${x.payment.kind === 'direct_debit' ? `<ram:DirectDebitMandateID>${esc(x.payment.mandateReference)}</ram:DirectDebitMandateID>` : ''}</ram:SpecifiedTradePaymentTerms>
      <ram:SpecifiedTradeSettlementHeaderMonetarySummation>
        <ram:LineTotalAmount>${amt(lineTotal)}</ram:LineTotalAmount>
        <ram:TaxBasisTotalAmount>${amt(lineTotal)}</ram:TaxBasisTotalAmount>
        <ram:TaxTotalAmount currencyID="EUR">${amt(taxTotal)}</ram:TaxTotalAmount>${rounding ? `\n        <ram:RoundingAmount>${amt(rounding)}</ram:RoundingAmount>` : ''}
        <ram:GrandTotalAmount>${amt(grand)}</ram:GrandTotalAmount>
        <ram:DuePayableAmount>${amt(payable)}</ram:DuePayableAmount>
      </ram:SpecifiedTradeSettlementHeaderMonetarySummation>${x.precedingNumber ? `\n      <ram:InvoiceReferencedDocument><ram:IssuerAssignedID>${esc(x.precedingNumber)}</ram:IssuerAssignedID></ram:InvoiceReferencedDocument>` : ''}
    </ram:ApplicableHeaderTradeSettlement>
  </rsm:SupplyChainTradeTransaction>
</rsm:CrossIndustryInvoice>
`;
}
