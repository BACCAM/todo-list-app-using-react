import { useMemo } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

export default function SortableTodoItem({
  id,
  item,
  editingId,
  editingText,
  setEditingId,
  setEditingText,
  commitEdit,
  handleEditKeyDown,
  handleToggle,
  handleDelete,
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id,
    disabled: false,
  });

  const style = useMemo(
    () => ({
      transform: CSS.Transform.toString(transform),
      transition,
      // keeps layout stable; doesn't change your CSS, only during drag
      opacity: isDragging ? 0.6 : undefined,
    }),
    [transform, transition, isDragging]
  );

  const handlePointerDown = (event) => {
    // Call dnd-kit listener first so drag can start, then stop bubbling to the row
    listeners?.onPointerDown?.(event);
    event.stopPropagation();
  };

  return (
    <li ref={setNodeRef} style={style} className="todo-item">
      {/* drag handle (positioned outside to the left) */}
      <button
        type="button"
        className="icon-btn drag-handle"
        ref={setActivatorNodeRef}
        // DnD kit needs these on the handle to start dragging
        {...attributes}
        {...listeners}
        // prevents mobile scrolling interference (no visual style change)
        style={{ touchAction: "none" }}
        aria-label="Drag to reorder"
        onPointerDown={handlePointerDown}
      >
        ≡
      </button>

      {/* checkbox slot */}
      <input
        className="todo-checkbox"
        type="checkbox"
        checked={item.isCompleted}
        onChange={(e) => handleToggle(item.id, e.target.checked)}
        onPointerDown={(e) => e.stopPropagation()}
      />

      {/* text / edit */}
      {editingId === item.id ? (
        <input
          className="edit-input"
          type="text"
          value={editingText}
          onChange={(e) => setEditingText(e.target.value)}
          onBlur={() => commitEdit(item.id)}
          onKeyDown={(e) => handleEditKeyDown(e, item.id)}
          autoFocus
          onPointerDown={(e) => e.stopPropagation()}
        />
      ) : (
        <span
          className={item.isCompleted ? "completed" : ""}
          onClick={(e) => {
            e.stopPropagation();
            setEditingId(item.id);
            setEditingText(item.content);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              setEditingId(item.id);
              setEditingText(item.content);
            }
          }}
          tabIndex={0}
        >
          {item.content}
        </span>
      )}

      {/* delete */}
      <button
        type="button"
        className="icon-btn"
        aria-label="Delete"
        onPointerDown={(e) => {
          e.stopPropagation();
          handleDelete(item.id);
        }}
      >
        ✕
      </button>
    </li>
  );
}
