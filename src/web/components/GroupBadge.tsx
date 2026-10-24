import { courtVar } from '../lib/hooks.ts';

/** A short court line in the group colour, then the name. */
export const GroupBadge = ({ name, color }: { name: string; color: string }) => <span className="court" style={courtVar(color)}>{name}</span>;
