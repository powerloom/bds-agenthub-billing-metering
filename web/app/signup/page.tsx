import { redirect } from "next/navigation";

/** Legacy path — signup and top-ups are served under /metering */
export default function SignupRedirectPage() {
  redirect("/metering");
}
