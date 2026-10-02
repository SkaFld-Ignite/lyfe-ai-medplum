// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import {
  ActionIcon,
  Badge,
  Box,
  CloseButton,
  Code,
  Collapse,
  Group,
  Paper,
  ScrollArea,
  Stack,
  Text,
  ThemeIcon,
  UnstyledButton,
} from '@mantine/core';
import { getDisplayString } from '@medplum/core';
import type { Communication, Patient, Reference } from '@medplum/fhirtypes';
import { useMedplum, useResource } from '@medplum/react';
import {
  IconArrowDown,
  IconArrowLeft,
  IconChevronDown,
  IconCode,
  IconLayoutSidebarLeftCollapse,
  IconLayoutSidebarLeftExpand,
  IconList,
  IconPlus,
  IconRobot,
  IconUser,
} from '@tabler/icons-react';
import cx from 'clsx';
import type { JSX, ReactNode } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { PromptComposer } from '../../pages/spaces/PromptComposer';
import type { Message } from '../../types/spaces';
import { showErrorNotification } from '../../utils/notifications';
import { displayableAssistantContent, processMessage } from '../../utils/spaceMessaging';
import type { ReasoningEffort } from '../../utils/spaceModels';
import { DEFAULT_REASONING_EFFORT, getDefaultModel, getProjectModels } from '../../utils/spaceModels';
import { loadConversationMessages } from '../../utils/spacePersistence';
import { CitedAssistantMessage } from '../lyfe-ai/CitedMarkdown';
import { hasDocCitations } from '../lyfe-ai/citations';
import { ComponentPreview } from './ComponentPreview';
import { HistoryList } from './HistoryList';
import { Markdown } from './Markdown';
import { ResourceBox } from './ResourceBox';
import { ResourcePanel } from './ResourcePanel';
import classes from './SpacesInbox.module.css';

/**
 * `page` fills a route of its own — the sidebar takes width beside the chat and the resource
 * panel splits the row. `panel` is the same chat inside the floating Lyfe AI launcher, where
 * both of those become overlays and the chrome comes from the launcher's own header.
 */
export type SpacesInboxVariant = 'page' | 'panel';

/** Handles the host needs to drive the chat from a header of its own. */
export interface SpacesInboxHeaderControls {
  sidebarOpen: boolean;
  toggleSidebar: () => void;
}

interface SpaceInboxProps {
  topic: Communication | Reference<Communication> | undefined;
  onNewTopic: (topic: Communication) => void;
  onSelectedItem: (topic: Communication) => string;
  onAdd?: () => void;
  /** Defaults to `page`. */
  variant?: SpacesInboxVariant;
  /**
   * Patients to start the composer with. This is the whole of "patient mode": the chart's
   * patient arrives pre-selected, and `processMessage` turns the selection into the system
   * message it already sends for a hand-picked patient. Read once, on mount — a host that
   * wants to switch patients remounts with a new `key`, which also starts a fresh conversation.
   */
  preselectedPatients?: (Patient | Reference<Patient>)[];
  /** Replaces the default header row. The host draws its own chrome and keeps the controls. */
  renderHeader?: (controls: SpacesInboxHeaderControls) => ReactNode;
  /** Replaces the default empty state. Receives a send function, for starter questions. */
  renderEmptyState?: (send: (question: string) => void) => ReactNode;
}

export function SpacesInbox(props: SpaceInboxProps): JSX.Element {
  const {
    topic: topicRef,
    onNewTopic,
    onSelectedItem,
    onAdd,
    variant = 'page',
    preselectedPatients,
    renderHeader,
    renderEmptyState,
  } = props;
  const dataVariant = variant === 'panel' ? 'panel' : undefined;
  const medplum = useMedplum();
  const topic = useResource(topicRef);
  const models = useMemo(() => getProjectModels(medplum), [medplum]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [selectedModel, setSelectedModel] = useState(() => getDefaultModel(models));
  const [selectedReasoningEffort, setSelectedReasoningEffort] = useState<ReasoningEffort>(DEFAULT_REASONING_EFFORT);
  const [hasStarted, setHasStarted] = useState(false);
  const [currentFhirRequest, setCurrentFhirRequest] = useState<string | undefined>();
  const [currentTopicId, setCurrentTopicId] = useState(topic?.id);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [selectedResource, setSelectedResource] = useState<string | undefined>();
  const [selectedResources, setSelectedResources] = useState<string[] | undefined>();
  const [resourceFromComponent, setResourceFromComponent] = useState(false);
  const [selectedPatients, setSelectedPatients] = useState<(Patient | Reference<Patient>)[]>(
    () => preselectedPatients ?? []
  );
  const [streamingContent, setStreamingContent] = useState<string | undefined>();
  const [streamingComponentCode, setStreamingComponentCode] = useState<string | undefined>();
  const [componentPanelOpen, setComponentPanelOpen] = useState(false);
  const [componentPreview, setComponentPreview] = useState<{ code: string; resources?: string[] } | undefined>();
  const [expandedResponses, setExpandedResponses] = useState(new Set<string>());
  const [showScrollButton, setShowScrollButton] = useState(false);
  const scrollViewportRef = useRef<HTMLDivElement>(null);
  const isSendingRef = useRef(false);
  const loadVersionRef = useRef(0);
  const isAtBottomRef = useRef(true);

  // Load conversation when topic changes
  useEffect(() => {
    const topicId = topic?.id;
    if (topicId) {
      if (isSendingRef.current) {
        return;
      }
      loadVersionRef.current++;
      const myVersion = loadVersionRef.current;
      const loadTopic = async (): Promise<void> => {
        try {
          setLoading(true);
          const loadedMessages = await loadConversationMessages(medplum, topicId);
          // Check if this load is stale (a newer load or send has started)
          if (myVersion !== loadVersionRef.current) {
            return;
          }
          setMessages([...loadedMessages]);
          isAtBottomRef.current = true;
          setShowScrollButton(false);
          setCurrentTopicId(topicId);
          setHasStarted(true);
          setSelectedResource(undefined);
          setSelectedResources(undefined);
          setComponentPreview(undefined);
          setStreamingComponentCode(undefined);
          setComponentPanelOpen(false);
        } catch (error) {
          showErrorNotification(error);
        } finally {
          if (myVersion === loadVersionRef.current) {
            setLoading(false);
          }
        }
      };
      loadTopic().catch(showErrorNotification);
    } else {
      setMessages([]);
      setHasStarted(false);
      setCurrentTopicId(undefined);
      setSelectedResource(undefined);
      setSelectedResources(undefined);
      setComponentPreview(undefined);
    }
  }, [topic, medplum]);

  useEffect(() => {
    const viewport = scrollViewportRef.current;
    if (viewport && hasStarted && isAtBottomRef.current) {
      viewport.scrollTo({
        top: viewport.scrollHeight,
        behavior: 'auto',
      });
    }
  }, [messages, hasStarted, streamingContent, loading, currentFhirRequest, streamingComponentCode]);

  // Scroll again after loading finishes to show resources
  useEffect(() => {
    const viewport = scrollViewportRef.current;
    if (viewport && hasStarted && !loading && isAtBottomRef.current) {
      const timer = setTimeout(() => {
        viewport.scrollTo({
          top: viewport.scrollHeight,
          behavior: 'auto',
        });
      }, 300);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [loading, hasStarted]);

  // Track whether the user is scrolled to the bottom; pause autoscroll otherwise
  const handleScrollPositionChange = (): void => {
    const viewport = scrollViewportRef.current;
    if (!viewport) {
      return;
    }
    const distanceFromBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
    const atBottom = distanceFromBottom < 100;
    isAtBottomRef.current = atBottom;
    setShowScrollButton(!atBottom);
  };

  const scrollToBottom = (): void => {
    const viewport = scrollViewportRef.current;
    if (viewport) {
      viewport.scrollTo({ top: viewport.scrollHeight, behavior: 'smooth' });
    }
    isAtBottomRef.current = true;
    setShowScrollButton(false);
  };

  const handleSelectTopic = async (selectedTopicId: string): Promise<void> => {
    loadVersionRef.current++;
    const myVersion = loadVersionRef.current;
    try {
      setLoading(true);
      const loadedMessages = await loadConversationMessages(medplum, selectedTopicId);
      if (myVersion !== loadVersionRef.current) {
        return;
      }
      setMessages([...loadedMessages]);
      isAtBottomRef.current = true;
      setShowScrollButton(false);
      setCurrentTopicId(selectedTopicId);
      setHasStarted(true);
      setSelectedResource(undefined);
      setSelectedResources(undefined);
      setComponentPreview(undefined);
      setStreamingComponentCode(undefined);
      setComponentPanelOpen(false);
    } catch (error) {
      showErrorNotification(error);
    } finally {
      if (myVersion === loadVersionRef.current) {
        setLoading(false);
      }
    }
  };

  const handleSend = async (overrideInput?: string): Promise<void> => {
    if (isSendingRef.current) {
      return;
    }
    const text = (overrideInput ?? input).trim();
    // A message can be sent with patient context alone, no text required
    if (!text && selectedPatients.length === 0) {
      return;
    }

    const isFirstMessage = !hasStarted;
    if (isFirstMessage) {
      setHasStarted(true);
    }

    const userMessage: Message = {
      role: 'user',
      content: text,
      selectedPatients: selectedPatients.length > 0 ? selectedPatients : undefined,
    };
    const currentMessages = [...messages, userMessage];
    setMessages(currentMessages);
    isAtBottomRef.current = true;
    setShowScrollButton(false);
    setInput('');
    setCurrentFhirRequest(undefined);
    setStreamingContent(undefined);
    setComponentPreview(undefined);
    setLoading(true);
    isSendingRef.current = true;
    loadVersionRef.current++;

    try {
      const result = await processMessage({
        medplum,
        input: text,
        userMessage,
        currentMessages,
        currentTopicId,
        selectedModel,
        selectedReasoningEffort,
        isFirstMessage,
        setCurrentTopicId,
        setRefreshKey,
        setCurrentFhirRequest,
        onNewTopic,
        selectedPatients,
        onStreamChunk: (chunk) => {
          setStreamingContent((prev) => (prev ?? '') + chunk);
          setCurrentFhirRequest(undefined);
        },
        onComponentStart: () => {
          // Show the "Generating component..." card and open the preview panel
          // immediately, before FHIR data is fetched and the first chunk arrives.
          setSelectedResource(undefined);
          setSelectedResources(undefined);
          setComponentPanelOpen(true);
          setStreamingComponentCode('');
          setCurrentFhirRequest(undefined);
        },
        onComponentStreamChunk: (chunk) => {
          setStreamingComponentCode((prev) => (prev ?? '') + chunk);
          setCurrentFhirRequest(undefined);
        },
      });
      setStreamingContent(undefined);
      setStreamingComponentCode(undefined);
      setMessages(result.updatedMessages);
      if (result.assistantMessage.componentCode) {
        setComponentPreview({
          code: result.assistantMessage.componentCode,
          resources: result.assistantMessage.resources,
        });
        setSelectedResource(undefined);
        setComponentPanelOpen(true);
      }
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      setMessages([...currentMessages, { role: 'assistant', content: `Error: ${errorMessage}` }]);
    } finally {
      isSendingRef.current = false;
      setStreamingContent(undefined);
      setStreamingComponentCode(undefined);
      setLoading(false);
      // componentPanelOpen intentionally left as-is so the panel stays open after streaming
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend().catch((error) => showErrorNotification(error));
    }
  };

  const toggleResponse = (id: string): void => {
    setExpandedResponses((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  /**
   * Opens one resource in the side panel, from a resource box or a `[doc:Sn]` citation pill.
   * @param reference - The resource to show, as a `ResourceType/id` string.
   */
  const openResource = (reference: string): void => {
    setComponentPanelOpen(false);
    setResourceFromComponent(false);
    setSelectedResources(undefined);
    setSelectedResource(reference);
  };

  const emptyState = renderEmptyState ? (
    // The callback only ever runs from a click, never during render, but the rule cannot see
    // past `renderEmptyState` to know that — `handleSend` reads `isSendingRef`.
    // eslint-disable-next-line react-hooks/refs
    renderEmptyState((question) => {
      handleSend(question).catch(showErrorNotification);
    })
  ) : (
    <div className={classes.emptyState}>
      <ThemeIcon size={64} radius="xl" variant="light" color="gray" className={classes.emptyStateIcon}>
        <IconRobot size={32} />
      </ThemeIcon>
      <Text size="xl" fw={500} mb="sm">
        How can I help you today?
      </Text>
      <Text c="dimmed" size="sm" maw={400}>
        I can help you search for patients, create resources, or answer clinical questions.
      </Text>
    </div>
  );

  const visibleMessages = messages.filter((m) => m.role !== 'system');

  // Map each tool response to the tool call that produced it, so each request can
  // be rendered together with its matching response.
  const toolResponsesByCallId = useMemo(() => {
    const map = new Map<string, Message>();
    for (const message of messages) {
      if (message.role === 'tool' && message.tool_call_id) {
        map.set(message.tool_call_id, message);
      }
    }
    return map;
  }, [messages]);

  // Deliberately not memoised. `processMessage` pushes into the same array this state holds, so
  // `messages` keeps its identity while a turn runs and a `useMemo` keyed on it would never see
  // the new entries — the page variant's request rows appear mid-turn precisely because this is
  // recomputed on every render, like `visibleMessages` above.
  const rows = buildRenderRows(visibleMessages, toolResponsesByCallId, variant, loading);

  return (
    <>
      {/* Sidebar */}
      <Box
        className={classes.sidebar}
        data-variant={dataVariant}
        style={{ width: sidebarOpen ? 280 : 0, opacity: sidebarOpen ? 1 : 0 }}
      >
        <div className={classes.sidebarHeader}>
          <Text className={classes.sidebarTitle}>Conversations</Text>
          <ActionIcon variant="subtle" color="gray" onClick={() => setSidebarOpen(false)}>
            <IconLayoutSidebarLeftCollapse size={18} />
          </ActionIcon>
        </div>
        <div className={classes.sidebarContent}>
          <HistoryList
            key={refreshKey}
            currentTopicId={currentTopicId}
            onSelectTopic={handleSelectTopic}
            onSelectedItem={onSelectedItem}
          />
        </div>
      </Box>

      {/* Main Chat Area */}
      <div className={classes.chatContainer} data-variant={dataVariant}>
        {renderHeader ? (
          renderHeader({ sidebarOpen, toggleSidebar: () => setSidebarOpen((v) => !v) })
        ) : (
          <div className={classes.chatHeader}>
            <div>
              {!sidebarOpen && (
                <ActionIcon variant="subtle" color="gray" onClick={() => setSidebarOpen(true)} mr="md">
                  <IconLayoutSidebarLeftExpand size={16} />
                </ActionIcon>
              )}
            </div>
            {onAdd && (
              <ActionIcon variant="subtle" color="gray" size="sm" onClick={onAdd} aria-label="New conversation">
                <IconPlus size={16} />
              </ActionIcon>
            )}
          </div>
        )}

        <div className={classes.messagesArea}>
          {!hasStarted ? (
            emptyState
          ) : (
            <ScrollArea
              style={{ flex: 1 }}
              viewportRef={scrollViewportRef}
              onScrollPositionChange={handleScrollPositionChange}
            >
              <Stack
                gap="xl"
                py={variant === 'panel' ? 'md' : 'xl'}
                px={variant === 'panel' ? 12 : 52}
                w="100%"
                maw={variant === 'panel' ? '100%' : 864}
                mx="auto"
              >
                {rows.map((row) => {
                  // FHIR tool calls — show each request paired with its response. This is the
                  // developer view, and the `page` variant puts it straight in the transcript.
                  if (row.kind === 'toolCalls') {
                    return (
                      <div key={row.key} className={cx(classes.messageWrapper, classes.assistantMessage)}>
                        <Stack gap="md">
                          {row.entries.map((entry) => (
                            <ToolCallDetail
                              key={entry.responseKey}
                              entry={entry}
                              expanded={expandedResponses.has(entry.responseKey)}
                              onToggle={() => toggleResponse(entry.responseKey)}
                            />
                          ))}
                        </Stack>
                      </div>
                    );
                  }

                  // The same detail, in the `panel` variant, behind one collapsed disclosure under
                  // the answer it produced.
                  if (row.kind === 'sources') {
                    return (
                      <SourcesConsulted
                        key={row.key}
                        entries={row.entries}
                        count={row.count}
                        expandedResponses={expandedResponses}
                        onToggleResponse={toggleResponse}
                      />
                    );
                  }

                  const { message, index } = row;

                  // Standard user / assistant messages
                  return (
                    <div
                      key={index}
                      className={cx(
                        classes.messageWrapper,
                        message.role === 'user' ? classes.userMessage : classes.assistantMessage
                      )}
                    >
                      {message.role === 'user' && message.selectedPatients && message.selectedPatients.length > 0 && (
                        <Stack gap={4} mb={4} align="flex-end">
                          {message.selectedPatients.map((patient, i) => (
                            <PatientContextBubble key={i} patient={patient} />
                          ))}
                        </Stack>
                      )}
                      {message.content &&
                        (message.role === 'assistant' ? (
                          /* Inline `[doc:Sn]` / `[meds]` citations become clickable pills, and the
                             sources they point at are listed under the bubble. The content is
                             scrubbed of any raw tool call the model narrated into its prose —
                             `processMessage` does the same for a turn happening now, and this
                             covers the conversations persisted before it did. */
                          <CitedAssistantMessage
                            content={displayableAssistantContent(message.content) as string}
                            resources={message.resources}
                            bubbleClassName={classes.messageContent}
                            onSelectResource={openResource}
                            collapsibleSources={variant === 'panel'}
                          />
                        ) : (
                          <div className={classes.messageContent}>
                            <Text style={{ whiteSpace: 'pre-wrap' }}>{message.content}</Text>
                          </div>
                        ))}
                      {message.componentCode && (
                        <Stack gap="xs" mt="sm" w={300} ml={message.role === 'assistant' ? 0 : 'auto'}>
                          <Paper
                            withBorder
                            p="sm"
                            style={{ cursor: 'pointer' }}
                            onClick={() => {
                              setSelectedResource(undefined);
                              setSelectedResources(undefined);
                              setComponentPreview({
                                code: message.componentCode as string,
                                resources: message.resources,
                              });
                              setComponentPanelOpen(true);
                            }}
                          >
                            <Group gap="sm" wrap="nowrap">
                              <ThemeIcon size="lg" variant="light" color="violet">
                                <IconCode size={20} />
                              </ThemeIcon>
                              <Text size="sm" fw={600} c="violet.7">
                                View Component
                              </Text>
                            </Group>
                          </Paper>
                        </Stack>
                      )}
                      {/* When the prose cites its sources, `CitedAssistantMessage` already lists
                          them with their `Sn` labels, so the unlabelled list would be a duplicate. */}
                      {message.resources &&
                        message.resources.length > 0 &&
                        !message.componentCode &&
                        !hasDocCitations(message.content) && (
                          <Stack gap="xs" mt="sm" w={300} ml={message.role === 'assistant' ? 0 : 'auto'}>
                            {message.resources.length <= 2 ? (
                              message.resources.map((resourceRef, idx) => (
                                <ResourceBox key={idx} resourceReference={resourceRef} onClick={openResource} />
                              ))
                            ) : (
                              <Paper
                                withBorder
                                p="sm"
                                style={{ cursor: 'pointer' }}
                                onClick={() => {
                                  setComponentPanelOpen(false);
                                  setSelectedResource(undefined);
                                  setResourceFromComponent(false);
                                  setSelectedResources(message.resources);
                                }}
                              >
                                <Group gap="sm" wrap="nowrap">
                                  <ThemeIcon size="lg" variant="light" color="violet">
                                    <IconList size={20} />
                                  </ThemeIcon>
                                  <Text size="sm" fw={600} c="violet.7">
                                    {message.resources.length} results
                                  </Text>
                                </Group>
                              </Paper>
                            )}
                          </Stack>
                        )}
                    </div>
                  );
                })}
                {loading && (
                  <div className={cx(classes.messageWrapper, classes.assistantMessage)}>
                    <div className={classes.messageContent}>
                      {streamingContent && (
                        <Markdown>{displayableAssistantContent(streamingContent) as string}</Markdown>
                      )}
                      {!streamingContent &&
                        currentFhirRequest &&
                        (variant === 'panel' ? (
                          /* One compact line for the whole turn. The raw step and FHIR path are
                             what the developer surface is for; a clinician gets told that the
                             records are being read, and the detail waits in `Sources consulted`. */
                          <Text size="sm" c="dimmed" fs="italic">
                            Looking through the records...
                          </Text>
                        ) : (
                          <Text size="sm" c="dimmed" fs="italic">
                            Executing {currentFhirRequest}...
                          </Text>
                        ))}
                      {!streamingContent && !currentFhirRequest && streamingComponentCode === undefined && (
                        <Text size="sm" c="dimmed" fs="italic">
                          Thinking...
                        </Text>
                      )}
                    </div>
                    {streamingComponentCode !== undefined && (
                      <Stack gap="xs" mt="sm" w={300}>
                        <Paper
                          withBorder
                          p="sm"
                          style={{ cursor: 'pointer' }}
                          onClick={() => {
                            setSelectedResource(undefined);
                            setComponentPanelOpen(true);
                          }}
                        >
                          <Group gap="sm" wrap="nowrap">
                            <ThemeIcon size="lg" variant="light" color="violet">
                              <IconCode size={20} />
                            </ThemeIcon>
                            <Text size="sm" fw={600} c="violet.7">
                              Generating component...
                            </Text>
                          </Group>
                        </Paper>
                      </Stack>
                    )}
                  </div>
                )}
              </Stack>
            </ScrollArea>
          )}
        </div>

        <div className={classes.inputArea} data-variant={dataVariant}>
          {hasStarted && showScrollButton && (
            <div className={classes.scrollToBottomWrapper}>
              <ActionIcon
                variant="default"
                radius="xl"
                size="lg"
                className={classes.scrollToBottomButton}
                onClick={scrollToBottom}
                aria-label="Scroll to bottom"
              >
                <IconArrowDown size={14} />
              </ActionIcon>
            </div>
          )}
          <div className={classes.inputWrapper}>
            <PromptComposer
              input={input}
              onInputChange={setInput}
              onKeyDown={handleKeyDown}
              onSend={handleSend}
              loading={loading}
              models={models}
              selectedModel={selectedModel}
              onModelChange={setSelectedModel}
              selectedReasoningEffort={selectedReasoningEffort}
              onReasoningEffortChange={setSelectedReasoningEffort}
              selectedPatients={selectedPatients}
              setSelectedPatients={setSelectedPatients}
              variant={variant}
            />
          </div>
          {/* The panel host draws its own disclaimer under the composer ("AI responses are
              informational only. Always verify clinical data."), which is the one production
              shows. Rendering this one too stacked two disclaimers in a 440px panel. */}
          {variant !== 'panel' && (
            <Text size="xs" c="gray.6" className={classes.inputDisclaimer}>
              AI models can make mistakes. Please double-check important information.
            </Text>
          )}
        </div>
      </div>

      {/* Resource List Panel */}
      {selectedResources && !selectedResource && (
        <div className={classes.resourcePanel} data-variant={dataVariant}>
          <div className={classes.resourceHeader}>
            <Text fw={600} size="sm">
              Results ({selectedResources.length})
            </Text>
            <CloseButton onClick={() => setSelectedResources(undefined)} />
          </div>
          <ScrollArea style={{ flex: 1 }} p="md">
            <Stack gap="xs">
              {selectedResources.map((ref, idx) => (
                <ResourceBox key={idx} resourceReference={ref} onClick={(r) => setSelectedResource(r)} />
              ))}
            </Stack>
          </ScrollArea>
        </div>
      )}

      {/* Resource Panel */}
      {selectedResource && (
        <div className={classes.resourcePanel} data-variant={dataVariant}>
          <div className={classes.resourceHeader}>
            <Group gap="xs">
              {(resourceFromComponent || selectedResources) && (
                <ActionIcon
                  variant="subtle"
                  color="gray"
                  size="sm"
                  onClick={() => {
                    setSelectedResource(undefined);
                    if (resourceFromComponent) {
                      setComponentPanelOpen(true);
                    }
                  }}
                >
                  <IconArrowLeft size={16} />
                </ActionIcon>
              )}
              <Text fw={600} size="sm">
                Resource Details
              </Text>
            </Group>
            <CloseButton
              onClick={() => {
                setSelectedResource(undefined);
                setSelectedResources(undefined);
              }}
            />
          </div>
          <ScrollArea style={{ flex: 1 }} p="md">
            <ResourcePanel key={selectedResource} resource={{ reference: selectedResource }} />
          </ScrollArea>
        </div>
      )}

      {/* Component Preview Panel */}
      {componentPanelOpen && (componentPreview || streamingComponentCode !== undefined) && (
        <div className={classes.resourcePanel} data-variant={dataVariant}>
          <div className={classes.resourceHeader}>
            <Text fw={600} size="sm">
              Component Preview
            </Text>
            <CloseButton onClick={() => setComponentPanelOpen(false)} />
          </div>
          <ScrollArea style={{ flex: 1 }} p="md">
            {streamingComponentCode !== undefined && (
              <Code block style={{ whiteSpace: 'pre-wrap' }}>
                {streamingComponentCode || ' '}
              </Code>
            )}
            {streamingComponentCode === undefined && componentPreview && (
              <ComponentPreview
                code={componentPreview.code}
                resources={componentPreview.resources}
                onResourceClick={(ref) => {
                  setComponentPanelOpen(false);
                  setResourceFromComponent(true);
                  setSelectedResource(ref);
                }}
              />
            )}
          </ScrollArea>
        </div>
      )}
    </>
  );
}

const METHOD_COLORS: Record<string, string> = {
  GET: 'blue',
  POST: 'green',
  PUT: 'orange',
  DELETE: 'red',
};

function getMethodColor(method: string | undefined): string {
  return METHOD_COLORS[method ?? ''] ?? 'gray';
}

/** One tool call paired with the tool message that answered it. */
interface ToolCallEntry {
  /** The tool call as `$ai` returned it — arguments may be a string or an object. */
  toolCall: { id?: string; function: { name: string; arguments: unknown } };
  /** The matching `role: 'tool'` message, if the call was executed. */
  response: Message | undefined;
  /** Stable React key and the identity the per-call response toggle is tracked under. */
  responseKey: string;
}

/**
 * One row of the transcript.
 *
 * `toolCalls` is the developer view, straight in the transcript, which is what the `page` variant
 * renders. `sources` is the same detail collected for a whole turn and placed *after* the answer,
 * which is what the `panel` variant renders.
 */
type RenderRow =
  | { kind: 'message'; message: Message; index: number }
  | { kind: 'toolCalls'; key: string; entries: ToolCallEntry[] }
  | { kind: 'sources'; key: string; entries: ToolCallEntry[]; count: number };

/**
 * A tool call's arguments, whichever form they arrived in.
 *
 * `$ai` parses them, but hands over the raw JSON string when it could not.
 * @param toolCall - The tool call.
 * @returns The arguments, or undefined if they do not parse.
 */
function parseToolCallArguments(toolCall: ToolCallEntry['toolCall']): { method?: string; path?: string } | undefined {
  try {
    const args = toolCall.function.arguments;
    return typeof args === 'string' ? JSON.parse(args) : (args as { method?: string; path?: string });
  } catch {
    return undefined;
  }
}

/**
 * How many distinct requests a turn issued.
 *
 * The count on the disclosure is a claim about sources, so it counts requests rather than rows: a
 * loop that re-ran the same search in two iterations consulted one source, not two. Identity is the
 * method and path for a FHIR request, and the tool name plus its arguments otherwise; a call whose
 * arguments do not parse at all counts once, under its own key, because something was asked for.
 * @param entries - The turn's tool calls.
 * @returns The number of distinct requests.
 */
function countDistinctRequests(entries: ToolCallEntry[]): number {
  const seen = new Set<string>();
  for (const entry of entries) {
    const args = parseToolCallArguments(entry.toolCall);
    const name = entry.toolCall.function.name;
    if (args?.path) {
      seen.add(`${args.method ?? 'CALL'} ${args.path}`);
    } else if (args) {
      seen.add(`${name} ${JSON.stringify(args)}`);
    } else {
      seen.add(`${name} ${entry.responseKey}`);
    }
  }
  return seen.size;
}

/**
 * Turns the message list into the rows to render.
 *
 * The transcript stores a turn as: the assistant's tool calls, the tool results, then the answer.
 * The `page` variant renders that order as-is. The `panel` variant holds the tool calls back until
 * the answer has been rendered and then emits them as one `sources` row, so a clinician reads the
 * paragraph first and the machinery is one collapsed line beneath it.
 *
 * A turn still in flight has its requests at the tail with no answer after them yet. In the panel
 * those are dropped while `loading`: the single progress line in the message area is the whole of
 * the in-flight UI, and a growing sources row would be a second, competing one.
 * @param visibleMessages - The transcript with system messages already filtered out.
 * @param toolResponsesByCallId - Tool messages keyed by the call they answered.
 * @param variant - Which surface is rendering.
 * @param loading - Whether a turn is in flight.
 * @returns The rows, in render order.
 */
function buildRenderRows(
  visibleMessages: Message[],
  toolResponsesByCallId: Map<string, Message>,
  variant: SpacesInboxVariant,
  loading: boolean
): RenderRow[] {
  const rows: RenderRow[] = [];
  let pending: ToolCallEntry[] = [];

  const flushSources = (): void => {
    if (pending.length === 0) {
      return;
    }
    const count = countDistinctRequests(pending);
    // A turn that issued nothing gets no control at all — never `Sources consulted (0)`.
    if (count > 0) {
      rows.push({ kind: 'sources', key: `sources-${pending[0].responseKey}`, entries: pending, count });
    }
    pending = [];
  };

  visibleMessages.forEach((message, index) => {
    // Tool responses are rendered with the request that produced them, never on their own.
    if (message.role === 'tool') {
      return;
    }

    if (message.role === 'assistant' && message.tool_calls && !message.content) {
      const entries: ToolCallEntry[] = message.tool_calls.map((toolCall, toolCallIndex) => ({
        toolCall,
        response: toolCall?.id ? toolResponsesByCallId.get(toolCall.id) : undefined,
        responseKey: toolCall?.id ?? `${index}-${toolCallIndex}`,
      }));
      if (variant === 'panel') {
        pending.push(...entries);
      } else {
        rows.push({ kind: 'toolCalls', key: `tools-${index}`, entries });
      }
      return;
    }

    // A new question starts a new turn, so anything still pending belonged to the last one.
    if (message.role === 'user') {
      flushSources();
      rows.push({ kind: 'message', message, index });
      return;
    }

    // The answer, then its sources underneath it.
    rows.push({ kind: 'message', message, index });
    flushSources();
  });

  if (!loading) {
    flushSources();
  }
  return rows;
}

/**
 * One request, its method badge and path, and its response behind a toggle.
 *
 * Unchanged from what the transcript has always rendered, and deliberately so: it is the escape
 * hatch a developer needs, it is simply no longer the first thing a clinician sees.
 * @param props - The component props.
 * @param props.entry - The request and the tool message that answered it.
 * @param props.expanded - Whether the raw response is showing.
 * @param props.onToggle - Toggles the raw response.
 * @returns The detail rows for one tool call.
 */
function ToolCallDetail(props: { entry: ToolCallEntry; expanded: boolean; onToggle: () => void }): JSX.Element {
  const { entry, expanded, onToggle } = props;
  const { toolCall, response } = entry;
  const args = parseToolCallArguments(toolCall);

  let prettyContent = response?.content ?? '';
  try {
    prettyContent = JSON.stringify(JSON.parse(response?.content ?? ''), null, 2);
  } catch {
    /* use raw */
  }

  return (
    <Stack gap={6}>
      {args ? (
        <Group gap="xs" align="flex-start" wrap="nowrap" className={classes.toolCallGroup}>
          <Badge size="sm" color={getMethodColor(args.method)} variant="filled" className={classes.toolCallBadge}>
            {args.method ?? 'CALL'}
          </Badge>
          <Code className={classes.toolCallPath}>{args.path ?? toolCall.function.name}</Code>
        </Group>
      ) : (
        <Text size="xs" c="dimmed" fs="italic">
          Unable to parse tool call
        </Text>
      )}
      {response && (
        <>
          <Group gap="xs" style={{ cursor: 'pointer', userSelect: 'none' }} onClick={onToggle}>
            <Text size="xs" fw={500} c="dimmed">
              Response
            </Text>
            <Text size="xs" c="dimmed">
              {expanded ? '▲' : '▼'}
            </Text>
          </Group>
          <Collapse in={expanded}>
            <Code block className={classes.toolResponseCode}>
              {prettyContent}
            </Code>
          </Collapse>
        </>
      )}
    </Stack>
  );
}

/**
 * The one line of machinery a clinician sees: `Sources consulted (n)`, collapsed.
 *
 * Open state is local and starts closed, which is the point — it resets on every remount and
 * nothing can auto-expand it. The detail is rendered only while open rather than hidden with CSS,
 * so a collapsed turn genuinely has no FHIR paths in the DOM.
 * @param props - The component props.
 * @param props.entries - Every tool call the turn issued, in order.
 * @param props.count - The number of distinct requests, as shown on the label.
 * @param props.expandedResponses - Which per-call responses are showing.
 * @param props.onToggleResponse - Toggles one per-call response.
 * @returns The disclosure and, while open, the detail.
 */
function SourcesConsulted(props: {
  entries: ToolCallEntry[];
  count: number;
  expandedResponses: Set<string>;
  onToggleResponse: (id: string) => void;
}): JSX.Element {
  const { entries, count, expandedResponses, onToggleResponse } = props;
  const [open, setOpen] = useState(false);

  return (
    <div className={cx(classes.messageWrapper, classes.assistantMessage, classes.sourcesRow)}>
      <UnstyledButton
        className={classes.sourcesToggle}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        data-open={open ? 'true' : undefined}
      >
        <span className={classes.sourcesLabel}>Sources consulted ({count})</span>
        <IconChevronDown size={13} stroke={2.5} className={classes.sourcesChevron} />
      </UnstyledButton>
      {open && (
        <Stack gap="md" className={classes.sourcesDetail}>
          {entries.map((entry) => (
            <ToolCallDetail
              key={entry.responseKey}
              entry={entry}
              expanded={expandedResponses.has(entry.responseKey)}
              onToggle={() => onToggleResponse(entry.responseKey)}
            />
          ))}
        </Stack>
      )}
    </div>
  );
}

function PatientContextBubble({ patient }: { patient: Patient | Reference<Patient> }): JSX.Element {
  const resource = useResource(patient);
  return (
    <div className={classes.contextBubble}>
      <Group gap={4} wrap="nowrap">
        <IconUser size={12} />
        <Text fz="xs">{resource ? getDisplayString(resource) : ''}</Text>
      </Group>
    </div>
  );
}
