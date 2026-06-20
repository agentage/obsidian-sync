// Minimal types for the `diff3` package (the 3-way line-merge lib isomorphic-git's
// own default driver uses). diff3Merge(a=ours, o=base, b=theirs) -> items that are
// either a clean run ({ ok }) or a conflict ({ conflict: { a=ours, b=theirs } }).
declare module 'diff3' {
  export interface Diff3Ok {
    ok: string[];
  }
  export interface Diff3Conflict {
    conflict: {
      a: string[];
      aIndex: number;
      o: string[];
      oIndex: number;
      b: string[];
      bIndex: number;
    };
  }
  export type Diff3Item = Diff3Ok | Diff3Conflict;
  export default function diff3Merge(a: string[], o: string[], b: string[]): Diff3Item[];
}
