/**
 * Myers diff algorithm implementation for computing differences between two texts.
 * No external dependencies.
 */

export interface DiffHunk {
    oldStart: number;
    oldLines: number;
    newStart: number;
    newLines: number;
    lines: DiffLine[];
}

export interface DiffLine {
    type: 'context' | 'add' | 'remove';
    content: string;
    oldLineNumber?: number;
    newLineNumber?: number;
}

export interface DiffResult {
    oldContent: string;
    newContent: string;
    hunks: DiffHunk[];
    additions: number;
    deletions: number;
}

/**
 * Compute the longest common subsequence edit script using Myers algorithm.
 * Returns an array of edit operations.
 */
function myersDiff(oldLines: string[], newLines: string[]): Array<{ type: 'equal' | 'insert' | 'delete'; oldIdx?: number; newIdx?: number }> {
    const N = oldLines.length;
    const M = newLines.length;
    const MAX = N + M;
    
    if (MAX === 0) return [];
    
    const V: Map<number, number>[] = [];
    const vCurrent = new Map<number, number>();
    vCurrent.set(1, 0);
    
    let found = false;
    
    for (let D = 0; D <= MAX; D++) {
        const vPrev = new Map(vCurrent);
        V.push(vPrev);
        
        for (let k = -D; k <= D; k += 2) {
            let x: number;
            if (k === -D || (k !== D && (vCurrent.get(k - 1) ?? 0) < (vCurrent.get(k + 1) ?? 0))) {
                x = vCurrent.get(k + 1) ?? 0;
            } else {
                x = (vCurrent.get(k - 1) ?? 0) + 1;
            }
            let y = x - k;
            
            while (x < N && y < M && oldLines[x] === newLines[y]) {
                x++;
                y++;
            }
            
            vCurrent.set(k, x);
            
            if (x >= N && y >= M) {
                found = true;
                // Backtrack to find the edit script
                return backtrack(V, D, oldLines, newLines);
            }
        }
    }
    
    if (!found) {
        return backtrack(V, MAX, oldLines, newLines);
    }
    return [];
}

function backtrack(
    V: Map<number, number>[],
    D: number,
    oldLines: string[],
    newLines: string[]
): Array<{ type: 'equal' | 'insert' | 'delete'; oldIdx?: number; newIdx?: number }> {
    const edits: Array<{ type: 'equal' | 'insert' | 'delete'; oldIdx?: number; newIdx?: number }> = [];
    let x = oldLines.length;
    let y = newLines.length;
    
    for (let d = D; d > 0; d--) {
        const v = V[d - 1];
        const k = x - y;
        
        let prevK: number;
        if (k === -d || (k !== d && (v.get(k - 1) ?? 0) < (v.get(k + 1) ?? 0))) {
            prevK = k + 1;
        } else {
            prevK = k - 1;
        }
        
        const prevX = v.get(prevK) ?? 0;
        const prevY = prevX - prevK;
        
        // Diagonal (equal) moves
        while (x > prevX && y > prevY) {
            x--;
            y--;
            edits.unshift({ type: 'equal', oldIdx: x, newIdx: y });
        }
        
        if (d > 0) {
            if (x === prevX) {
                // Insert
                y--;
                edits.unshift({ type: 'insert', newIdx: y });
            } else {
                // Delete
                x--;
                edits.unshift({ type: 'delete', oldIdx: x });
            }
        }
    }
    
    // Remaining diagonal at d=0
    while (x > 0 && y > 0) {
        x--;
        y--;
        edits.unshift({ type: 'equal', oldIdx: x, newIdx: y });
    }
    
    return edits;
}

/**
 * Convert edit operations to unified diff hunks with context lines.
 */
function editsToHunks(
    edits: Array<{ type: 'equal' | 'insert' | 'delete'; oldIdx?: number; newIdx?: number }>,
    oldLines: string[],
    newLines: string[],
    contextLines: number = 3
): DiffHunk[] {
    const hunks: DiffHunk[] = [];
    
    // Find groups of changes with context
    const changes: Array<{ index: number; edit: typeof edits[0] }> = [];
    edits.forEach((edit, index) => {
        if (edit.type !== 'equal') {
            changes.push({ index, edit });
        }
    });
    
    if (changes.length === 0) return [];
    
    // Group changes that are within contextLines*2 of each other
    const groups: Array<{ start: number; end: number }> = [];
    let currentGroup = { start: changes[0].index, end: changes[0].index };
    
    for (let i = 1; i < changes.length; i++) {
        if (changes[i].index - currentGroup.end <= contextLines * 2) {
            currentGroup.end = changes[i].index;
        } else {
            groups.push({ ...currentGroup });
            currentGroup = { start: changes[i].index, end: changes[i].index };
        }
    }
    groups.push(currentGroup);
    
    // Build hunks from groups
    for (const group of groups) {
        const hunkStart = Math.max(0, group.start - contextLines);
        const hunkEnd = Math.min(edits.length - 1, group.end + contextLines);
        
        const lines: DiffLine[] = [];
        let oldStart = -1;
        let newStart = -1;
        let oldCount = 0;
        let newCount = 0;
        
        for (let i = hunkStart; i <= hunkEnd; i++) {
            const edit = edits[i];
            
            if (edit.type === 'equal') {
                const oldNum = (edit.oldIdx ?? 0) + 1;
                const newNum = (edit.newIdx ?? 0) + 1;
                if (oldStart === -1) { oldStart = oldNum; newStart = newNum; }
                lines.push({
                    type: 'context',
                    content: oldLines[edit.oldIdx ?? 0],
                    oldLineNumber: oldNum,
                    newLineNumber: newNum,
                });
                oldCount++;
                newCount++;
            } else if (edit.type === 'delete') {
                const oldNum = (edit.oldIdx ?? 0) + 1;
                if (oldStart === -1) { oldStart = oldNum; newStart = newCount + 1; }
                lines.push({
                    type: 'remove',
                    content: oldLines[edit.oldIdx ?? 0],
                    oldLineNumber: oldNum,
                });
                oldCount++;
            } else if (edit.type === 'insert') {
                const newNum = (edit.newIdx ?? 0) + 1;
                if (oldStart === -1) { oldStart = oldCount + 1; newStart = newNum; }
                lines.push({
                    type: 'add',
                    content: newLines[edit.newIdx ?? 0],
                    newLineNumber: newNum,
                });
                newCount++;
            }
        }
        
        if (lines.length > 0) {
            hunks.push({
                oldStart: oldStart === -1 ? 1 : oldStart,
                oldLines: oldCount,
                newStart: newStart === -1 ? 1 : newStart,
                newLines: newCount,
                lines,
            });
        }
    }
    
    return hunks;
}

/**
 * Compute a structured diff between two text contents.
 */
export function computeDiff(oldContent: string, newContent: string): DiffResult {
    const oldLines = oldContent ? oldContent.split('\n') : [];
    const newLines = newContent ? newContent.split('\n') : [];
    
    const edits = myersDiff(oldLines, newLines);
    const hunks = editsToHunks(edits, oldLines, newLines);
    
    let additions = 0;
    let deletions = 0;
    for (const hunk of hunks) {
        for (const line of hunk.lines) {
            if (line.type === 'add') additions++;
            if (line.type === 'remove') deletions++;
        }
    }
    
    return { oldContent, newContent, hunks, additions, deletions };
}

/**
 * Parse conflict markers from a file's content into structured sections.
 */
export interface ConflictSection {
    startLine: number;
    endLine: number;
    ours: string;
    theirs: string;
    base?: string;
    oursLabel: string;
    theirsLabel: string;
}

export function parseConflictMarkers(content: string): ConflictSection[] {
    const lines = content.split('\n');
    const conflicts: ConflictSection[] = [];
    let i = 0;
    
    while (i < lines.length) {
        if (lines[i].startsWith('<<<<<<<')) {
            const oursLabel = lines[i].substring(7).trim();
            const startLine = i;
            const oursLines: string[] = [];
            const baseLines: string[] = [];
            const theirsLines: string[] = [];
            let section: 'ours' | 'base' | 'theirs' = 'ours';
            let theirsLabel = '';
            i++;
            
            while (i < lines.length) {
                if (lines[i].startsWith('|||||||')) {
                    section = 'base';
                    i++;
                    continue;
                }
                if (lines[i].startsWith('=======')) {
                    section = 'theirs';
                    i++;
                    continue;
                }
                if (lines[i].startsWith('>>>>>>>')) {
                    theirsLabel = lines[i].substring(7).trim();
                    conflicts.push({
                        startLine,
                        endLine: i,
                        ours: oursLines.join('\n'),
                        theirs: theirsLines.join('\n'),
                        base: baseLines.length > 0 ? baseLines.join('\n') : undefined,
                        oursLabel,
                        theirsLabel,
                    });
                    break;
                }
                
                if (section === 'ours') oursLines.push(lines[i]);
                else if (section === 'base') baseLines.push(lines[i]);
                else theirsLines.push(lines[i]);
                i++;
            }
        }
        i++;
    }
    
    return conflicts;
}
