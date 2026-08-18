"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { toast } from "sonner";
import { TelegramLink } from "@/types/db";

interface TelegramSettingsProps {
  userId: string;
  initialLink: TelegramLink | null;
}

export function TelegramSettings({ userId, initialLink }: TelegramSettingsProps) {
  const [link, setLink] = useState<TelegramLink | null>(initialLink);
  const [linkUrl, setLinkUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const supabase = createClient();

  const botUsername = process.env.NEXT_PUBLIC_TELEGRAM_BOT_USERNAME;

  async function handleGenerateLink() {
    setLoading(true);
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

    const { data, error } = await supabase
      .from("telegram_link_tokens")
      .insert({ user_id: userId, expires_at: expiresAt })
      .select()
      .single();

    if (error) {
      toast.error("Failed to generate link token");
      setLoading(false);
      return;
    }

    const url = `https://t.me/${botUsername}?start=${data.token}`;
    setLinkUrl(url);
    setLoading(false);
  }

  async function handleDisconnect() {
    const { error } = await supabase
      .from("telegram_links")
      .delete()
      .eq("user_id", userId);

    if (error) {
      toast.error("Failed to disconnect");
    } else {
      setLink(null);
      toast.success("Telegram disconnected");
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Telegram</CardTitle>
        <CardDescription>
          Connect your Telegram account to manage leads from your phone.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {link ? (
          <div className="space-y-3">
            <p className="text-sm text-green-600 dark:text-green-400">
              Connected (ID: {link.telegram_user_id})
            </p>
            <Button variant="outline" size="sm" onClick={handleDisconnect}>
              Disconnect
            </Button>
          </div>
        ) : linkUrl ? (
          <div className="space-y-3">
            <p className="text-sm">
              Open this link in Telegram to connect your account:
            </p>
            <a
              href={linkUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm text-blue-600 dark:text-blue-400 underline break-all"
            >
              {linkUrl}
            </a>
            <p className="text-xs text-muted-foreground">
              This link expires in 10 minutes.
            </p>
          </div>
        ) : (
          <Button onClick={handleGenerateLink} disabled={loading}>
            {loading ? "Generating..." : "Connect Telegram"}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
