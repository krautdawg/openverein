import { useQuery } from '@tanstack/react-query';
import { Navigate, Route, Routes, useLocation } from 'react-router';
import { PortalApp } from './portal/Portal.tsx';
import { ApplicationForm } from './pages/ApplicationForm.tsx';
import { Shell } from './components/Shell.tsx';
import { api } from './lib/api.ts';
import { useInstanceConfig, useMe } from './lib/session.tsx';
import { Login } from './pages/Login.tsx';
import { Overview } from './pages/Overview.tsx';
import { Setup } from './pages/Setup.tsx';
import { AcceptInvite } from './pages/AcceptInvite.tsx';
import { Unsubscribe } from './pages/Unsubscribe.tsx';
import { Groups } from './pages/Groups.tsx';
import { FeePlans } from './pages/Fees.tsx';
import { FeeRunDetail, FeeRuns } from './pages/FeeRuns.tsx';
import { Dunning, Invoices } from './pages/Invoices.tsx';
import { Events } from './pages/Events.tsx';
import { Communication } from './pages/Communication.tsx';
import { Documents } from './pages/Documents.tsx';
import { Accounts, EuerReport, Journal, LedgerExports, LedgerSettings } from './pages/Ledger.tsx';
import { DonationReceipts, Donations, DonationSettingsPage } from './pages/Donations.tsx';
import { Households } from './pages/Households.tsx';
import { CashBookPage, Receipts } from './pages/Receipts.tsx';
import { Duplicates } from './pages/Duplicates.tsx';
import { Census } from './pages/Census.tsx';
import { HonoursPage } from './pages/Honours.tsx';
import { WorkHours } from './pages/WorkHours.tsx';
import { MailSettings } from './pages/settings/MailSettings.tsx';
import { ApplicationSettings } from './pages/settings/ApplicationSettings.tsx';
import { ImportSettings } from './pages/settings/ImportSettings.tsx';
import { PrivacySettings } from './pages/settings/PrivacySettings.tsx';
import { FullExport } from './pages/settings/FullExport.tsx';
import { CustomFieldSettings } from './pages/settings/CustomFieldSettings.tsx';
import { SecuritySettings } from './pages/settings/SecuritySettings.tsx';
import { Applications } from './pages/Applications.tsx';
import { BankAccounts, CollectionRunDetail, Collections, Reconciliation } from './pages/Bank.tsx';
import { Members } from './pages/Members.tsx';
import { ApiTokens } from './pages/settings/ApiTokens.tsx';
import { AuditLog } from './pages/settings/AuditLog.tsx';
import { ClubSettings } from './pages/settings/ClubSettings.tsx';
import { Roles } from './pages/settings/Roles.tsx';
import { SettingsLayout } from './pages/settings/SettingsLayout.tsx';
import { Users } from './pages/settings/Users.tsx';
import './lib/search.ts';

/** The member portal is its own small app with its own sign-in; everything else is the admin app. */
export function App() {
  const { pathname } = useLocation();
  if (pathname.startsWith('/aufnahme/')) return <Routes><Route path="/aufnahme/:slug" element={<ApplicationForm />} /></Routes>;
  return pathname.startsWith('/portal') ? <PortalApp /> : <AdminApp />;
}

function AdminApp() {
  const setup = useQuery({ queryKey: ['setup'], queryFn: () => api<{ needsSetup: boolean }>('/setup') });
  const me = useMe();
  const cfg = useInstanceConfig();

  if (setup.isPending || me.isPending) return null;
  if (setup.isError || me.isError) {
    return (
      <main className="page" role="alert">
        <h1>OpenVerein ist gerade nicht erreichbar.</h1>
        <p className="muted" style={{ margin: 'var(--s-3) 0 var(--s-5)' }}>Der Server antwortet nicht. Versuche es gleich noch einmal.</p>
        <button className="btn btn-primary" onClick={() => { void setup.refetch(); void me.refetch(); }}>Erneut versuchen</button>
      </main>
    );
  }
  if (setup.data?.needsSetup) {
    return (
      <Routes>
        <Route path="*" element={<Setup />} />
      </Routes>
    );
  }
  if (!me.data) {
    return (
      <Routes>
        <Route path="/anmelden" element={<Login />} />
        <Route path="/einladung" element={<AcceptInvite />} />
        <Route path="/abmelden" element={<Unsubscribe />} />
        <Route path="*" element={<Navigate to="/anmelden" replace />} />
      </Routes>
    );
  }
  return (
    <Routes>
      <Route element={<Shell me={me.data} demo={!!cfg.data?.demo || me.data.organization.isDemo} />}>
        <Route index element={<Overview me={me.data} />} />
        <Route path="/mitglieder" element={<Members me={me.data} />} />
        <Route path="/mitglieder/haushalte" element={<Households me={me.data} />} />
        <Route path="/mitglieder/dubletten" element={<Duplicates me={me.data} />} />
        <Route path="/mitglieder/bestandserhebung" element={<Census />} />
        <Route path="/mitglieder/ehrungen" element={<HonoursPage me={me.data} />} />
        <Route path="/mitglieder/arbeitsstunden" element={<WorkHours me={me.data} />} />
        <Route path="/mitglieder/:id" element={<Members me={me.data} />} />
        <Route path="/gruppen" element={<Groups me={me.data} />} />
        <Route path="/gruppen/:id" element={<Groups me={me.data} />} />
        <Route path="/termine" element={<Events me={me.data} />} />
        <Route path="/termine/:id/:date" element={<Events me={me.data} />} />
        <Route path="/buchhaltung" element={<Journal me={me.data} />} />
        <Route path="/buchhaltung/euer" element={<EuerReport me={me.data} />} />
        <Route path="/buchhaltung/konten" element={<Accounts me={me.data} />} />
        <Route path="/buchhaltung/einstellungen" element={<LedgerSettings me={me.data} />} />
        <Route path="/buchhaltung/export" element={<LedgerExports me={me.data} />} />
        <Route path="/buchhaltung/belege" element={<Receipts me={me.data} />} />
        <Route path="/buchhaltung/kassenbuch" element={<CashBookPage me={me.data} />} />
        <Route path="/buchhaltung/:id" element={<Journal me={me.data} />} />
        <Route path="/spenden" element={<Donations me={me.data} />} />
        <Route path="/spenden/bestaetigungen" element={<DonationReceipts me={me.data} />} />
        <Route path="/spenden/einstellungen" element={<DonationSettingsPage me={me.data} />} />
        <Route path="/antraege" element={<Applications me={me.data} />} />
        <Route path="/antraege/:id" element={<Applications me={me.data} />} />
        <Route path="/kommunikation" element={<Communication me={me.data} />} />
        <Route path="/dokumente" element={<Documents me={me.data} />} />
        <Route path="/dokumente/:id" element={<Documents me={me.data} />} />
        <Route path="/kommunikation/:id" element={<Communication me={me.data} />} />
        <Route path="/beitraege" element={<FeePlans me={me.data} />} />
        <Route path="/beitraege/laeufe" element={<FeeRuns me={me.data} />} />
        <Route path="/beitraege/laeufe/:id" element={<FeeRunDetail me={me.data} />} />
        <Route path="/beitraege/:id" element={<FeePlans me={me.data} />} />
        <Route path="/rechnungen" element={<Invoices me={me.data} />} />
        <Route path="/rechnungen/mahnwesen" element={<Dunning me={me.data} />} />
        <Route path="/rechnungen/mahnwesen/:id" element={<Dunning me={me.data} />} />
        <Route path="/rechnungen/:id" element={<Invoices me={me.data} />} />
        <Route path="/bank" element={<BankAccounts me={me.data} />} />
        <Route path="/bank/abgleich" element={<Reconciliation me={me.data} />} />
        <Route path="/bank/lastschriften" element={<Collections me={me.data} />} />
        <Route path="/bank/lastschriften/:id" element={<CollectionRunDetail me={me.data} />} />
        <Route path="/einstellungen" element={<SettingsLayout me={me.data} />}>
          <Route index element={<ClubSettings me={me.data} />} />
          <Route path="email" element={<MailSettings me={me.data} />} />
          <Route path="aufnahme" element={<ApplicationSettings me={me.data} />} />
          <Route path="import" element={<ImportSettings me={me.data} />} />
          <Route path="datenschutz" element={<PrivacySettings me={me.data} />} />
          <Route path="export" element={<FullExport />} />
          <Route path="felder" element={<CustomFieldSettings me={me.data} />} />
          <Route path="sicherheit" element={<SecuritySettings me={me.data} />} />
          <Route path="zugaenge" element={<Users me={me.data} />} />
          <Route path="rollen" element={<Roles me={me.data} />} />
          <Route path="api" element={<ApiTokens me={me.data} />} />
          <Route path="protokoll" element={<AuditLog />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
