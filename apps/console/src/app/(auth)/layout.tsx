import { BrandFrame } from "@/components/brand";

export default function AuthLayout({ children }: LayoutProps<"/">) {
  return <BrandFrame>{children}</BrandFrame>;
}
