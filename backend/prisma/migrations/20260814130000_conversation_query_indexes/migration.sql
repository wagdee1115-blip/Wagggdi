CREATE INDEX "Conversation_updatedAt_id_idx"
ON "Conversation"("updatedAt", "id");

CREATE INDEX "ConversationParticipant_userId_conversationId_idx"
ON "ConversationParticipant"("userId", "conversationId");

CREATE INDEX "Message_conversationId_createdAt_id_idx"
ON "Message"("conversationId", "createdAt", "id");
