import { STATUS_LABEL, type MemberStatus } from '../../shared/members.ts';

export const StatusBadge = ({ status }: { status: MemberStatus }) => <span className="status" data-s={status}>{STATUS_LABEL[status]}</span>;
