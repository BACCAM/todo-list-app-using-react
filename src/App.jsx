import { useEffect, useMemo, useRef, useState } from "react";
import "./App.css";

import {
  DndContext,
  closestCenter,
  DragOverlay,
  PointerSensor,
  TouchSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";

import {
  SortableContext,
  verticalListSortingStrategy,
  arrayMove,
} from "@dnd-kit/sortable";

import SortableTodoItem from "./components/SortableTodoItem";
import { supabase } from "./lib/supabaseClient";

const TABLE_NAME = "todos";
// Supabase column names in your schema
const COL_CONTENT = "title";
const COL_COMPLETED = "completed";
const LOCAL_STORAGE_KEY = "todo-guest-items";

function hasLocalStorage() {
  return typeof window !== "undefined" && typeof window.localStorage !== "undefined";
}

function reindex(itemsList) {
  return itemsList.map((item, index) => ({ ...item, position: index }));
}

function orderByCompletion(itemsList) {
  const actives = itemsList.filter((item) => !item.isCompleted);
  const completed = itemsList.filter((item) => item.isCompleted);
  return reindex([...actives, ...completed]);
}

function loadGuestItems() {
  if (!hasLocalStorage()) return [];
  const raw = window.localStorage.getItem(LOCAL_STORAGE_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function persistGuestItems(nextItems) {
  if (!hasLocalStorage()) return;
  try {
    window.localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(nextItems));
  } catch {
    // ignore storage write errors
  }
}

function clearGuestItems() {
  if (!hasLocalStorage()) return;
  window.localStorage.removeItem(LOCAL_STORAGE_KEY);
}

function generateLocalId() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return `local-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export default function App() {
  const [now, setNow] = useState(new Date());

  const [items, setItems] = useState(() => reindex(loadGuestItems()));

  const [filter, setFilter] = useState("all");
  const [draft, setDraft] = useState("");

  const [editingId, setEditingId] = useState(null);
  const [editingText, setEditingText] = useState("");

  const [activeId, setActiveId] = useState(null);
  const [session, setSession] = useState(null);
  const [isLoading, setIsLoading] = useState(false);
  const [authError, setAuthError] = useState("");
  const [authNotice, setAuthNotice] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [dataError, setDataError] = useState("");
  const [authMode, setAuthMode] = useState("signIn");
  const [isResettingPassword, setIsResettingPassword] = useState(false);

  const hasSupabase = Boolean(supabase);
  const hadSessionRef = useRef(false);

  useEffect(() => {
    const interval = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (!hasSupabase) return undefined;

    let ignore = false;
    supabase.auth.getSession().then(({ data }) => {
      if (ignore) return;
      const hadSession = hadSessionRef.current;
      setSession(data.session);
      hadSessionRef.current = Boolean(data.session);
      if (!data.session && hadSession) {
        setItems([]);
        setIsLoading(false);
        clearGuestItems();
      }
    });

    const { data: authListener } = supabase.auth.onAuthStateChange(
      (_event, nextSession) => {
        const hadSession = hadSessionRef.current;
        setSession(nextSession);
        hadSessionRef.current = Boolean(nextSession);
        if (!nextSession && hadSession) {
          setItems([]);
          setIsLoading(false);
          clearGuestItems();
        }
        if (_event === "PASSWORD_RECOVERY") {
          setIsResettingPassword(true);
          setAuthMode("reset");
          setAuthNotice("Enter a new password to finish resetting.");
          setAuthError("");
          setNewPassword("");
          setConfirmPassword("");
        }
      }
    );

    return () => {
      ignore = true;
      authListener.subscription?.unsubscribe();
    };
  }, [hasSupabase]);

  // Sensors: mouse/trackpad + touch
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 80, tolerance: 8 } })
  );

  function handleSubmit(e) {
    e.preventDefault();
    const content = draft.trim();
    if (!content) return;

    const firstCompletedIndex = items.findIndex((i) => i.isCompleted);
    const insertIndex = firstCompletedIndex === -1 ? items.length : firstCompletedIndex;

    if (!session || !hasSupabase) {
      const newItem = {
        id: generateLocalId(),
        content,
        isCompleted: false,
        position: insertIndex,
      };
      const nextItems = [...items];
      nextItems.splice(insertIndex, 0, newItem);
      syncAll(nextItems);
      setDraft("");
      return;
    }

      supabase
        .from(TABLE_NAME)
        .insert([
          {
            [COL_CONTENT]: content,
            [COL_COMPLETED]: false,
            position: insertIndex,
            user_id: session.user.id,
          },
        ])
      .select()
      .then(({ data, error }) => {
        if (error) {
          setDataError(error.message);
          return;
        }
        const inserted = data?.[0];
        if (!inserted) return;
        const newItem = {
          id: inserted.id,
          content: inserted[COL_CONTENT],
          isCompleted: inserted[COL_COMPLETED],
          position: insertIndex,
        };
        const nextItems = [...items];
        nextItems.splice(insertIndex, 0, newItem);
        syncAll(nextItems);
        setDraft("");
      });
  }

  function handleToggle(id, isCompleted) {
    setItems((prev) => {
      const updated = prev.map((item) => {
        if (item.id !== id) return item;
        return { ...item, isCompleted };
      });
      const actives = updated.filter((i) => !i.isCompleted);
      const completed = updated.filter((i) => i.isCompleted);
      const nextItems = [...actives, ...completed];
      syncAll(nextItems);
      return nextItems;
    });
  }

  function handleDelete(id) {
    if (hasSupabase && session) {
      supabase
        .from(TABLE_NAME)
        .delete()
        .eq("id", id)
        .then(({ error }) => {
          if (error) setDataError(error.message);
        });
    }

    setItems((prev) => {
      const nextItems = prev.filter((item) => item.id !== id);
      syncAll(nextItems);
      return nextItems;
    });
  }

  const visibleItems = useMemo(() => {
    if (filter === "active") return items.filter((i) => !i.isCompleted);
    if (filter === "completed") return items.filter((i) => i.isCompleted);
    return items;
  }, [filter, items]);

  function commitEdit(id) {
    const nextContent = editingText.trim();
    if (!nextContent) {
      setEditingId(null);
      return;
    }

    setItems((prev) => {
      const nextItems = prev.map((item) =>
        item.id === id ? { ...item, content: nextContent } : item
      );
      syncAll(nextItems);
      return nextItems;
    });
    setEditingId(null);
  }

  function handleEditKeyDown(e, id) {
    if (e.key === "Enter") {
      e.preventDefault();
      commitEdit(id);
    }
    if (e.key === "Escape") {
      setEditingId(null);
    }
  }

  function onDragStart(event) {
    setActiveId(event.active.id);
    setEditingId(null); // avoid edit conflicts during drag
  }

  function onDragCancel() {
    setActiveId(null);
  }

  function onDragEnd(event) {
    const { active, over } = event;
    setActiveId(null);

    if (!over) return;
    if (active.id === over.id) return;

    setItems((prev) => {
      const activeItem = prev.find((i) => i.id === active.id);
      const overItem = prev.find((i) => i.id === over.id);
      if (!activeItem || !overItem) return prev;

      const byId = new Map(prev.map((i) => [i.id, i]));
      const activeIds = prev.filter((i) => !i.isCompleted).map((i) => i.id);
      const completedIds = prev.filter((i) => i.isCompleted).map((i) => i.id);

      const segmentIds = activeItem.isCompleted ? completedIds : activeIds;
      const fromIndex = segmentIds.indexOf(active.id);
      if (fromIndex < 0) return prev;

      const overSameSegment = activeItem.isCompleted === overItem.isCompleted;
      if (!overSameSegment) {
        // dragging across segments leaves positions unchanged
        return prev;
      }

      const toIndex = segmentIds.indexOf(over.id);
      if (toIndex < 0) return prev;

      const reorderedSegment = arrayMove(segmentIds, fromIndex, toIndex);
      const nextActiveIds = activeItem.isCompleted ? activeIds : reorderedSegment;
      const nextCompletedIds = activeItem.isCompleted
        ? reorderedSegment
        : completedIds;

      const nextItems = [...nextActiveIds, ...nextCompletedIds].map((id) => byId.get(id));
      syncAll(nextItems);
      return nextItems;
    });
  }

  function syncAll(nextItems) {
    const withPositions = reindex(nextItems);
    setItems(withPositions);

    if (!session || !hasSupabase) {
      persistGuestItems(withPositions);
      return;
    }

      const payload = withPositions.map((item) => ({
        id: item.id,
        [COL_CONTENT]: item.content,
        [COL_COMPLETED]: item.isCompleted,
        position: item.position,
        user_id: session.user.id,
      }));

    supabase.from(TABLE_NAME).upsert(payload).then(({ error }) => {
      if (error) setDataError(error.message);
    });
  }

    function normalizeRows(rows) {
    return rows
      .map((row, index) => ({
        id: row.id,
        content: row[COL_CONTENT],
        isCompleted: row[COL_COMPLETED],
        position: typeof row.position === "number" ? row.position : index,
      }))
      .sort((a, b) => a.position - b.position);
  }

  useEffect(() => {
    if (!session || !hasSupabase) return;

    let cancelled = false;
    async function loadAndMerge() {
      setIsLoading(true);
      setDataError("");

      const guestItems = reindex(loadGuestItems());

      const { data, error } = await supabase
        .from(TABLE_NAME)
        .select(`id, ${COL_CONTENT}, ${COL_COMPLETED}, position`)
        .eq("user_id", session.user.id)
        .order("position", { ascending: true })
        .order("created_at", { ascending: true });

      if (cancelled) return;
      if (error) {
        setDataError(error.message);
        setItems([]);
        setIsLoading(false);
        return;
      }

      const existing = orderByCompletion(normalizeRows(data || []));

      if (!guestItems.length) {
        setItems(existing);
        const payload = existing.map((item) => ({
          id: item.id,
          [COL_CONTENT]: item.content,
          [COL_COMPLETED]: item.isCompleted,
          position: item.position,
          user_id: session.user.id,
        }));
        supabase.from(TABLE_NAME).upsert(payload).then(({ error: upsertError }) => {
          if (upsertError) setDataError(upsertError.message);
        });
        setIsLoading(false);
        return;
      }

      const insertPayload = guestItems.map((item, index) => ({
        [COL_CONTENT]: item.content,
        [COL_COMPLETED]: item.isCompleted,
        position: existing.length + index,
        user_id: session.user.id,
      }));

      const { error: insertError } = await supabase
        .from(TABLE_NAME)
        .insert(insertPayload);

      if (cancelled) return;
      if (insertError) {
        setDataError(insertError.message);
        setItems(existing);
        setIsLoading(false);
        return;
      }

      clearGuestItems();

      const { data: refreshed, error: refreshError } = await supabase
        .from(TABLE_NAME)
        .select(`id, ${COL_CONTENT}, ${COL_COMPLETED}, position`)
        .eq("user_id", session.user.id)
        .order("position", { ascending: true })
        .order("created_at", { ascending: true });

      if (cancelled) return;

      if (refreshError) {
        setDataError(refreshError.message);
        setItems(existing);
      } else if (refreshed) {
        const ordered = orderByCompletion(normalizeRows(refreshed));
        setItems(ordered);
        const payload = ordered.map((item) => ({
          id: item.id,
          [COL_CONTENT]: item.content,
          [COL_COMPLETED]: item.isCompleted,
          position: item.position,
          user_id: session.user.id,
        }));
        supabase.from(TABLE_NAME).upsert(payload).then(({ error: upsertError }) => {
          if (upsertError) setDataError(upsertError.message);
        });
      }
      setIsLoading(false);
    }

    loadAndMerge();

    return () => {
      cancelled = true;
    };
  }, [hasSupabase, session]);

  function handleAuthSubmit(e) {
    e.preventDefault();
    setAuthError("");
    setAuthNotice("");
    if (!hasSupabase) {
      setAuthError("Supabase not configured.");
      return;
    }
    if (authMode === "resetRequest") {
      if (!email) {
        setAuthError("Enter your email to reset your password.");
        return;
      }
      supabase.auth.resetPasswordForEmail(email).then(({ error }) => {
        if (error) {
          setAuthError(error.message);
        } else {
          setAuthMode("resetSent");
          setAuthError("");
          setAuthNotice("Password reset email sent. Check your inbox.");
          setPassword("");
        }
      });
      return;
    }

    if (authMode === "signUp") {
      supabase.auth
        .signUp({ email, password })
        .then(({ error, data }) => {
          if (error) {
            const msg = error.message || "";
            if (msg.toLowerCase().includes("already") || msg.toLowerCase().includes("exists")) {
              setAuthError("An account already exists for this email. Try signing in or resetting your password.");
            } else {
              setAuthError(msg);
            }
            return;
          }
          const identities = data.user?.identities;
          if (Array.isArray(identities) && identities.length === 0) {
            setAuthError(
              "An account already exists for this email. Try signing in or resetting your password."
            );
            return;
          }
          const requiresEmailConfirmation = !data.session;
          if (requiresEmailConfirmation) {
            setAuthNotice("Check your email to confirm your account.");
          } else {
            setAuthNotice("Signed up and signed in!");
          }
          setPassword("");
        });
      return;
    }

    supabase.auth
      .signInWithPassword({ email, password })
      .then(({ error }) => {
        if (error) setAuthError(error.message);
        else {
          setEmail("");
          setPassword("");
          setAuthNotice("");
        }
      });
  }

  function handlePasswordReset() {
    setAuthError("");
    setAuthNotice("");
    setAuthMode("resetRequest");
    setPassword("");
  }

  function handlePasswordUpdate(e) {
    e.preventDefault();
    setAuthError("");
    setAuthNotice("");
    if (!hasSupabase) {
      setAuthError("Supabase not configured.");
      return;
    }
    if (!newPassword) {
      setAuthError("Enter a new password.");
      return;
    }
    if (newPassword !== confirmPassword) {
      setAuthError("Passwords do not match.");
      return;
    }
    supabase.auth.updateUser({ password: newPassword }).then(({ error }) => {
      if (error) {
        setAuthError(error.message);
      } else {
        setAuthNotice("Password updated. You can continue using the app.");
        setNewPassword("");
        setConfirmPassword("");
        setIsResettingPassword(false);
        setAuthMode("signIn");
      }
    });
  }

  function switchAuthMode(nextMode) {
    setAuthMode(nextMode);
    setAuthError("");
    setAuthNotice("");
    setPassword("");
  }

  function handleSignOut() {
    clearGuestItems();
    setItems([]);
    hadSessionRef.current = false;
    setIsResettingPassword(false);
    setAuthMode("signIn");
    setAuthNotice("");
    setAuthError("");
    if (hasSupabase) supabase.auth.signOut();
  }

  const activeItem = useMemo(
    () => items.find((i) => i.id === activeId) || null,
    [activeId, items]
  );

  return (
    <div className="app">
      <div className="auth-wrapper">
        {!hasSupabase && (
          <div className="hint error">
            Supabase is not configured. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY
            in your .env file.
          </div>
        )}
        {isResettingPassword ? (
          <form className="auth" onSubmit={handlePasswordUpdate}>
            <h2>Reset your password</h2>
            <input
              type="password"
              placeholder="New password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              required
            />
            <input
              type="password"
              placeholder="Confirm new password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              required
            />
            <button type="submit" className="primary-btn">
              Update password
            </button>
            <button type="button" onPointerDown={() => setIsResettingPassword(false)}>
              Cancel
            </button>
            {authError && <div className="hint error">{authError}</div>}
            {authNotice && <div className="hint">{authNotice}</div>}
          </form>
        ) : !session ? (
          authMode === "resetSent" ? (
            <div className="auth">
              <h2>Check your inbox</h2>
              <div className="hint">We sent a password reset link to your email.</div>
              <button type="button" onClick={handlePasswordReset}>
                Resend email
              </button>
            </div>
          ) : (
            <form className="auth" onSubmit={handleAuthSubmit}>
              <h2>{authMode === "signUp" ? "Create your account" : "Sign in to your list"}</h2>
              {authMode === "resetRequest" ? (
                <div className="hint">We’ll email a reset link to this address.</div>
              ) : null}
              <input
                type="email"
                placeholder="Email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
              {authMode !== "resetRequest" && (
                <input
                  type="password"
                  placeholder={authMode === "signUp" ? "Create password" : "Password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                />
              )}
              <button type="submit" className="primary-btn">
                {authMode === "signUp"
                  ? "Sign up"
                  : authMode === "resetRequest"
                  ? "Send reset link"
                  : "Sign in"}
              </button>
              {authMode === "resetRequest" && (
                <button type="button" onClick={() => switchAuthMode("signIn")}>
                  Cancel
                </button>
              )}
              {authMode !== "resetRequest" && (
                <button
                  type="button"
                  onClick={() =>
                    switchAuthMode(authMode === "signUp" ? "signIn" : "signUp")
                  }
                >
                  {authMode === "signUp" ? "Have an account? Sign in" : "Need an account? Sign up"}
                </button>
              )}
              {authMode === "signIn" && (
                <button type="button" onClick={handlePasswordReset}>
                  Forgot your password?
                </button>
              )}
              {authError && <div className="hint error">{authError}</div>}
              {authNotice && <div className="hint">{authNotice}</div>}
            </form>
          )
        ) : (
          <div className="auth-row">
            <div className="hint">Signed in as {session.user.email}</div>
            <button type="button" onPointerDown={handleSignOut}>
              Sign out
            </button>
          </div>
        )}
      </div>

      <div className="header">
        <div className="date">
          {now.toLocaleDateString(undefined, {
            weekday: "long",
            month: "long",
            day: "numeric",
            year: "numeric",
          })}
        </div>
        <div className="time">
          {now.toLocaleTimeString(undefined, {
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
          })}
        </div>
      </div>

      {/* ADD ROW */}
      <form className="todo-row add-row" onSubmit={handleSubmit}>
        <span className="slot" aria-hidden="true" />
        <input
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="What are you going to do?"
        />
        <button type="submit" className="primary-btn" aria-label="Add item">
          +
        </button>
      </form>

      {/* FILTERS */}
      <div className="filters">
        <button
          type="button"
          className={filter === "all" ? "active" : ""}
          onPointerDown={() => setFilter("all")}
        >
          All
        </button>
        <button
          type="button"
          className={filter === "active" ? "active" : ""}
          onPointerDown={() => setFilter("active")}
        >
          Active
        </button>
        <button
          type="button"
          className={filter === "completed" ? "active" : ""}
          onPointerDown={() => setFilter("completed")}
        >
          Completed
        </button>
      </div>

      {/* LIST + DND */}
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={onDragStart}
        onDragCancel={onDragCancel}
        onDragEnd={onDragEnd}
      >
        {/* IMPORTANT: SortableContext must always receive the ids of the DOM list being rendered */}
        <SortableContext
          items={visibleItems.map((i) => i.id)}
          strategy={verticalListSortingStrategy}
        >
          <ul className="todo-list">
            {visibleItems.map((item) => (
              <SortableTodoItem
                key={item.id}
                id={item.id}
                item={item}
                editingId={editingId}
                editingText={editingText}
                setEditingId={setEditingId}
                setEditingText={setEditingText}
                commitEdit={commitEdit}
                handleEditKeyDown={handleEditKeyDown}
                handleToggle={handleToggle}
                handleDelete={handleDelete}
              />
            ))}
            {isLoading && <li className="todo-item">Loading...</li>}
            {dataError && <li className="todo-item hint error">{dataError}</li>}
          </ul>
        </SortableContext>

        <DragOverlay dropAnimation={{ duration: 140, easing: "cubic-bezier(.2,.8,.2,1)" }}>
          {activeItem ? (
            <div className="drag-overlay">
              <span className="icon-btn drag-handle" aria-hidden="true">
                ≡
              </span>
              <div className="slot" aria-hidden="true" />
              <div className="overlay-text">{activeItem.content}</div>
              <div className="overlay-delete" aria-hidden="true">
                <span className="icon-btn">✕</span>
              </div>
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>
    </div>
  );
}
