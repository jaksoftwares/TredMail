import Image from "next/image";

export default function AuthLayout({ children }: LayoutProps<"/">) {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center px-4 py-10">
      <div className="mb-8 flex flex-col items-center gap-2">
        <Image src="/brand/brandmark.svg" alt="" width={44} height={46} priority />
        <p className="text-xl font-extrabold tracking-tight text-navy">
          TredMail <span className="text-sm font-semibold text-subtle">by Dovepeak</span>
        </p>
      </div>
      <div className="w-full max-w-md rounded-lg border border-line bg-surface p-6 shadow-sm sm:p-8">{children}</div>
      <p className="mt-8 text-xs text-subtle">© Dovepeak Technologies</p>
    </main>
  );
}
