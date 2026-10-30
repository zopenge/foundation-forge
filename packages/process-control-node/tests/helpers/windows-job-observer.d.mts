interface MemberObservation {
  pid: number;
  belongs?: number | null;
  wait?: number;
  exitCode?: number | null;
  image?: string | null;
}

interface QueryObservation {
  at: number;
  job: number;
  class: number;
  queryOk: boolean;
  assigned?: number;
  count?: number;
  active?: number;
  total?: number;
  nativeCode?: number;
}

export declare function observeWindowsJobMembers(): Promise<{
  members: MemberObservation[];
  queries: QueryObservation[];
  queryFailures: QueryObservation[];
  restore: () => void;
}>;
