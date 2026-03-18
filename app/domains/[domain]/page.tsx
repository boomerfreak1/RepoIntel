"use client";

import { useEffect, useState } from "react";
import {
  Header,
  HeaderName,
  HeaderNavigation,
  HeaderMenuItem,
  Content,
  Grid,
  Column,
  Tile,
  Tag,
  Button,
  SkeletonText,
} from "@carbon/react";
import { ArrowLeft } from "@carbon/icons-react";
import { useParams } from "next/navigation";

interface Entity {
  id: number;
  entity_type: string;
  content: string;
  status: string;
  owner: string | null;
  domain: string;
  confidence: number;
  first_seen_at: string;
}

type TagType = "blue" | "red" | "purple" | "teal" | "cyan" | "green" | "gray" | "magenta" | "cool-gray" | "warm-gray" | "high-contrast" | "outline";

const TYPE_COLORS: Record<string, TagType> = {
  decision: "blue",
  gap: "red",
  dependency: "purple",
  stakeholder: "teal",
  milestone: "cyan",
  workflow: "green",
};

export default function DomainPage() {
  const params = useParams();
  const domain = decodeURIComponent(params.domain as string);
  const [entities, setEntities] = useState<Entity[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`/api/entities?domain=${encodeURIComponent(domain)}`)
      .then((res) => res.json())
      .then((data) => setEntities(data.entities ?? []))
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [domain]);

  const grouped = entities.reduce<Record<string, Entity[]>>((acc, e) => {
    (acc[e.entity_type] ??= []).push(e);
    return acc;
  }, {});

  return (
    <>
      <Header aria-label="RepoIntel">
        <HeaderName href="/" prefix="">
          RepoIntel
        </HeaderName>
        <HeaderNavigation aria-label="Navigation">
          <HeaderMenuItem href="/">Dashboard</HeaderMenuItem>
          <HeaderMenuItem href="/chat">Chat</HeaderMenuItem>
        </HeaderNavigation>
      </Header>

      <Content style={{ paddingTop: "3rem" }}>
        <Grid style={{ maxWidth: "1200px", margin: "0 auto" }}>
          <Column lg={16} md={8} sm={4} style={{ paddingTop: "2rem", marginBottom: "1.5rem" }}>
            <Button kind="ghost" size="sm" renderIcon={ArrowLeft} href="/" style={{ marginBottom: "1rem" }}>
              Dashboard
            </Button>
            <h1 style={{ fontSize: "2rem", fontWeight: 300, marginBottom: "0.5rem" }}>
              {domain}
            </h1>
            <p style={{ fontSize: "0.875rem", color: "var(--cds-text-secondary)" }}>
              {entities.length} entities across {Object.keys(grouped).length} types
            </p>
          </Column>

          {loading ? (
            <Column lg={16} md={8} sm={4}>
              <SkeletonText paragraph lineCount={6} />
            </Column>
          ) : entities.length === 0 ? (
            <Column lg={16} md={8} sm={4}>
              <Tile style={{ textAlign: "center", padding: "3rem" }}>
                <p style={{ color: "var(--cds-text-secondary)" }}>
                  No entities found for domain &quot;{domain}&quot;.
                </p>
              </Tile>
            </Column>
          ) : (
            Object.entries(grouped).map(([type, items]) => (
              <Column key={type} lg={16} md={8} sm={4} style={{ marginBottom: "1.5rem" }}>
                <h3 style={{ fontSize: "1rem", fontWeight: 600, marginBottom: "0.75rem", textTransform: "capitalize" }}>
                  {type}s
                  <Tag type={TYPE_COLORS[type] ?? "gray"} size="sm" style={{ marginLeft: "0.5rem" }}>
                    {items.length}
                  </Tag>
                </h3>
                <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
                  {items.map((entity) => (
                    <Tile key={entity.id} style={{ padding: "0.75rem 1rem" }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "1rem" }}>
                        <p style={{ fontSize: "0.875rem", lineHeight: 1.5, flex: 1 }}>
                          {entity.content}
                        </p>
                        <div style={{ display: "flex", gap: "0.25rem", flexShrink: 0 }}>
                          <Tag type={entity.status === "open" ? "red" : entity.status === "resolved" ? "green" : entity.status === "blocked" ? "magenta" : "gray"} size="sm">
                            {entity.status}
                          </Tag>
                          {entity.owner && (
                            <Tag type="cool-gray" size="sm">{entity.owner}</Tag>
                          )}
                        </div>
                      </div>
                    </Tile>
                  ))}
                </div>
              </Column>
            ))
          )}
        </Grid>
      </Content>
    </>
  );
}
