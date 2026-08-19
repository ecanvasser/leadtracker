export default function Loading() {
  return (
    <div className="flex-1 flex items-center justify-center animate-in fade-in duration-200">
      <div className="h-5 w-5 border-2 border-muted-foreground/30 border-t-muted-foreground rounded-full animate-spin" />
    </div>
  );
}
