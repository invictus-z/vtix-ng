import { and, desc, eq, inArray, sql } from "drizzle-orm";
import {
  db,
  dbDialect,
  problemCommentLikes,
  problemCommentReports,
  problemComments,
  problems,
} from "../db";
import { hasPermission, PERMISSIONS } from "../utils/permissions";
import type { User } from "../utils/session";
import { createMessage } from "./messages";

export const MAX_COMMENT_LENGTH = 500;
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 5;

export type CommentPayload = {
  id: number;
  problemId: number;
  userId: string;
  userName: string;
  content: string;
  floor: number;
  likeCount: number;
  liked: boolean;
  createdAt: number;
  updatedAt: number;
};

export type ReportedCommentPayload = {
  reportId: number;
  commentId: number;
  problemId: number;
  commentUserName: string;
  commentContent: string;
  floor: number;
  likeCount: number;
  reporterId: number;
  reason: string | null;
  status: string;
  createdAt: number;
};

// In-memory, single-process rate limiter for posting comments.
const commentPostTimestamps = new Map<number, number[]>();

export function checkCommentRateLimit(userId: number): boolean {
  const now = Date.now();
  const recent = (commentPostTimestamps.get(userId) ?? []).filter(
    (ts) => now - ts < RATE_LIMIT_WINDOW_MS
  );
  if (recent.length >= RATE_LIMIT_MAX) {
    commentPostTimestamps.set(userId, recent);
    return false;
  }
  recent.push(now);
  commentPostTimestamps.set(userId, recent);
  return true;
}

function toCommentPayload(
  row: {
    id: number;
    problemId: number;
    userId: number;
    userName: string;
    content: string;
    floor: number;
    likeCount: number;
    createdAt: number;
    updatedAt: number;
  },
  liked: boolean
): CommentPayload {
  return {
    id: Number(row.id),
    problemId: Number(row.problemId),
    userId: String(row.userId),
    userName: row.userName,
    content: row.content,
    floor: Number(row.floor),
    likeCount: Number(row.likeCount ?? 0),
    liked,
    createdAt: Number(row.createdAt),
    updatedAt: Number(row.updatedAt),
  };
}

function extractInsertedId(result: unknown): number | null {
  if (Array.isArray(result) && result.length > 0) {
    const first = result[0] as any;
    if (typeof first === "number") return first;
    if (first && typeof first.id === "number") return first.id;
    if (first && typeof first.id === "string" && Number.isFinite(Number(first.id))) {
      return Number(first.id);
    }
  }
  if (typeof result === "number") return result;
  if (result && typeof (result as any).id === "number") return (result as any).id;
  return null;
}

export async function loadCommentsPage(options: {
  problemId: number;
  page: number;
  pageSize: number;
  sort: "latest" | "hot";
  viewerId?: number;
}): Promise<{ items: CommentPayload[]; total: number }> {
  const { problemId, page, pageSize, sort, viewerId } = options;
  const offset = Math.max(0, (page - 1) * pageSize);

  const [countRow] = await db
    .select({ count: sql<number>`count(*)` })
    .from(problemComments)
    .where(eq(problemComments.problemId, problemId));
  const total = Number(countRow?.count ?? 0);

  const order =
    sort === "hot"
      ? [desc(problemComments.likeCount), desc(problemComments.id)]
      : [desc(problemComments.id)];

  const rows = (await db
    .select({
      id: problemComments.id,
      problemId: problemComments.problemId,
      userId: problemComments.userId,
      userName: problemComments.userName,
      content: problemComments.content,
      floor: problemComments.floor,
      likeCount: problemComments.likeCount,
      createdAt: problemComments.createdAt,
      updatedAt: problemComments.updatedAt,
    })
    .from(problemComments)
    .where(eq(problemComments.problemId, problemId))
    .orderBy(...order)
    .limit(pageSize)
    .offset(offset)) as Array<{
    id: number;
    problemId: number;
    userId: number;
    userName: string;
    content: string;
    floor: number;
    likeCount: number;
    createdAt: number;
    updatedAt: number;
  }>;

  let likedSet = new Set<number>();
  if (viewerId && rows.length > 0) {
    const ids = rows.map((row) => Number(row.id));
    const likes = await db
      .select({ commentId: problemCommentLikes.commentId })
      .from(problemCommentLikes)
      .where(
        and(
          eq(problemCommentLikes.userId, viewerId),
          inArray(problemCommentLikes.commentId, ids)
        )
      );
    likedSet = new Set(likes.map((like: { commentId: number }) => Number(like.commentId)));
  }

  return {
    items: rows.map((row) =>
      toCommentPayload(row, likedSet.has(Number(row.id)))
    ),
    total,
  };
}

export async function createComment(options: {
  problemId: number;
  user: User;
  content: string;
}): Promise<CommentPayload | { error: string } | null> {
  const { problemId, user } = options;
  const userId = Number(user.id);
  if (!Number.isFinite(userId)) {
    return { error: "Invalid user." };
  }
  const trimmed = options.content.trim();
  if (!trimmed) {
    return { error: "评论内容不能为空。" };
  }
  if (trimmed.length > MAX_COMMENT_LENGTH) {
    return { error: `评论不能超过 ${MAX_COMMENT_LENGTH} 个字。` };
  }

  const [problemRow] = await db
    .select({ id: problems.id })
    .from(problems)
    .where(eq(problems.id, problemId))
    .limit(1);
  if (!problemRow) {
    return null;
  }

  const now = Date.now();

  return db.transaction(async (tx: typeof db) => {
    const [countRow] = await tx
      .select({ count: sql<number>`count(*)` })
      .from(problemComments)
      .where(eq(problemComments.problemId, problemId));
    const floor = Number(countRow?.count ?? 0) + 1;

    const row = {
      problemId,
      userId,
      userName: user.name,
      content: trimmed,
      floor,
      likeCount: 0,
      createdAt: now,
      updatedAt: now,
    };

    let id: number | null = null;
    if (dbDialect === "mysql") {
      const result = await (tx.insert(problemComments).values(row) as any).$returningId();
      id = extractInsertedId(result);
    } else {
      const result = await tx
        .insert(problemComments)
        .values(row)
        .returning({ id: problemComments.id });
      id = extractInsertedId(result);
    }
    if (id === null) {
      throw new Error("Failed to insert comment.");
    }

    return {
      id,
      problemId,
      userId: String(userId),
      userName: user.name,
      content: trimmed,
      floor,
      likeCount: 0,
      liked: false,
      createdAt: now,
      updatedAt: now,
    };
  });
}

export async function toggleCommentLike(options: {
  commentId: number;
  userId: number;
  likerName: string;
}): Promise<{ liked: boolean; likeCount: number } | null> {
  const { commentId, userId, likerName } = options;

  const result = await db.transaction(async (tx: typeof db) => {
    const [commentRow] = await tx
      .select({ id: problemComments.id, likeCount: problemComments.likeCount })
      .from(problemComments)
      .where(eq(problemComments.id, commentId))
      .limit(1);
    if (!commentRow) return null;

    const [existing] = await tx
      .select({ commentId: problemCommentLikes.commentId })
      .from(problemCommentLikes)
      .where(
        and(
          eq(problemCommentLikes.commentId, commentId),
          eq(problemCommentLikes.userId, userId)
        )
      )
      .limit(1);

    const now = Date.now();
    if (existing) {
      await tx
        .delete(problemCommentLikes)
        .where(
          and(
            eq(problemCommentLikes.commentId, commentId),
            eq(problemCommentLikes.userId, userId)
          )
        );
      await tx
        .update(problemComments)
        .set({ likeCount: sql`${problemComments.likeCount} - 1` })
        .where(eq(problemComments.id, commentId));
      return { liked: false, likeCount: Math.max(0, Number(commentRow.likeCount) - 1) };
    }

    await tx.insert(problemCommentLikes).values({
      commentId,
      userId,
      createdAt: now,
    });
    await tx
      .update(problemComments)
      .set({ likeCount: sql`${problemComments.likeCount} + 1` })
      .where(eq(problemComments.id, commentId));
    return { liked: true, likeCount: Number(commentRow.likeCount) + 1 };
  });

  // Notify the comment author when someone new likes their comment
  // (message type 2 = comment-like; review notifications use type 1).
  // Skip self-likes and never notify on unliking.
  if (result && result.liked) {
    try {
      const [authorRow] = await db
        .select({
          userId: problemComments.userId,
          userName: problemComments.userName,
          floor: problemComments.floor,
        })
        .from(problemComments)
        .where(eq(problemComments.id, commentId))
        .limit(1);
      if (authorRow && Number(authorRow.userId) !== userId) {
        await createMessage({
          senderId: userId,
          senderName: likerName,
          receiverId: Number(authorRow.userId),
          receiverName: authorRow.userName,
          content: `${likerName} 赞了你的评论（${authorRow.floor}楼）`,
          type: 2,
          link: null,
        });
      }
    } catch (error) {
      console.warn("[comments] failed to notify comment author of like", error);
    }
  }

  return result;
}

export async function reportComment(options: {
  commentId: number;
  reporterId: number;
  reason?: string;
}): Promise<{ ok: boolean; alreadyReported?: boolean } | null> {
  const { commentId, reporterId } = options;
  const reason = options.reason?.trim() || null;

  const [commentRow] = await db
    .select({ id: problemComments.id })
    .from(problemComments)
    .where(eq(problemComments.id, commentId))
    .limit(1);
  if (!commentRow) return null;

  const [existing] = await db
    .select({ id: problemCommentReports.id })
    .from(problemCommentReports)
    .where(
      and(
        eq(problemCommentReports.commentId, commentId),
        eq(problemCommentReports.reporterId, reporterId)
      )
    )
    .limit(1);
  if (existing) {
    return { ok: true, alreadyReported: true };
  }

  await db.insert(problemCommentReports).values({
    commentId,
    reporterId,
    reason,
    status: "open",
    createdAt: Date.now(),
  });
  return { ok: true };
}

export async function deleteComment(options: {
  commentId: number;
  user: User;
}): Promise<{ ok: boolean; allowed: boolean }> {
  const { commentId, user } = options;
  const userId = Number(user.id);

  const [row] = await db
    .select({ id: problemComments.id, userId: problemComments.userId })
    .from(problemComments)
    .where(eq(problemComments.id, commentId))
    .limit(1);
  if (!row) {
    return { ok: false, allowed: false };
  }

  const isOwner = Number(row.userId) === userId;
  const canManage = hasPermission(user.permissions, PERMISSIONS.MANAGE_COMMENTS);
  if (!isOwner && !canManage) {
    return { ok: false, allowed: false };
  }

  await db.delete(problemComments).where(eq(problemComments.id, commentId));
  return { ok: true, allowed: true };
}

export async function loadReportedCommentsPage(options: {
  page: number;
  pageSize: number;
}): Promise<{ items: ReportedCommentPayload[]; total: number }> {
  const { page, pageSize } = options;
  const offset = Math.max(0, (page - 1) * pageSize);

  const [countRow] = await db
    .select({ count: sql<number>`count(*)` })
    .from(problemCommentReports);
  const total = Number(countRow?.count ?? 0);

  const rows = (await db
    .select({
      reportId: problemCommentReports.id,
      commentId: problemCommentReports.commentId,
      problemId: problemComments.problemId,
      commentUserName: problemComments.userName,
      commentContent: problemComments.content,
      floor: problemComments.floor,
      likeCount: problemComments.likeCount,
      reporterId: problemCommentReports.reporterId,
      reason: problemCommentReports.reason,
      status: problemCommentReports.status,
      createdAt: problemCommentReports.createdAt,
    })
    .from(problemCommentReports)
    .innerJoin(
      problemComments,
      eq(problemCommentReports.commentId, problemComments.id)
    )
    .orderBy(desc(problemCommentReports.createdAt))
    .limit(pageSize)
    .offset(offset)) as Array<{
    reportId: number;
    commentId: number;
    problemId: number;
    commentUserName: string;
    commentContent: string;
    floor: number;
    likeCount: number;
    reporterId: number;
    reason: string | null;
    status: string;
    createdAt: number;
  }>;

  return { items: rows, total };
}
